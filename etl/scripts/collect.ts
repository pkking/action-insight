// ETL script: fetches GitHub Actions runs/jobs and writes to PostgreSQL
import { Octokit } from '@octokit/core';
import { addDays, format, subDays, parseISO, isBefore, startOfDay } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  parseCollectCliOptions,
  resolveTargetRepos,
  CLI_HELP,
  type CollectCliOptions,
} from './collect-options.ts';
import collectionWindows, { type CollectionWindow } from '../../src/lib/collection-windows.ts';
import { createOctokit, getGitHubIdentity, getRateLimitDetails, isGitHubRateLimitError, resolveGitHubTokens, type RateLimitDetails } from './github.ts';
import {
  persistCollectionWindow,
  getCachedWorkflowAttempts,
  readRunListValidator,
  writeRunListValidator,
  readCollectionState,
  getCollectedDates,
  checkEtlFreshness,
  formatFreshnessReport,
} from './pg-storage.ts';
import { readPullRequestsFromPayload } from './github-utils.ts';
import type { GitHubApiPayload, PullRequestRef, Step } from '../../src/lib/types.ts';
import { getRepoNames, parseReposConfig, type RepoConfigEntry, type ReposConfig } from './repos-config.ts';
import { buildWorkflowAttempts, enrichRunWithWorkflowMetadata } from './workflow-attempts.ts';

const { buildCollectionWindows, splitCollectionWindow, toCreatedRange } = collectionWindows;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERBOSE = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
const PER_PAGE = 100;
const MAX_RESULTS_PER_QUERY = 1000;

function log(...args: unknown[]) {
  if (VERBOSE) {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }
}

function warn(...args: unknown[]) {
  if (VERBOSE) {
    console.warn(`[${new Date().toISOString()}] WARN:`, ...args);
  }
}

function error(...args: unknown[]) {
  console.error(`[${new Date().toISOString()}] ERROR:`, ...args);
}

function isTransientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  const status = e.status as number | undefined;
  if (status !== undefined && status >= 500 && status < 600) return true;
  const code = e.code as string | undefined;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_SOCKET_TIMEOUT'].includes(code)) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      warn(`Transient API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`, err);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

interface Run {
  id: number;
  name: string;
  head_branch: string;
  head_sha?: string;
  status: string;
  conclusion: string;
  event?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  pull_requests?: PullRequestRef[];
  jobs?: Job[];
  githubPayload?: GitHubApiPayload;
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
  labels?: string[];
  runner_id?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  resource_model?: string;
  resource_count?: number;
  githubPayload?: GitHubApiPayload;
  steps?: Step[];
}

interface GitHubJobPayload extends GitHubApiPayload {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  created_at?: string;
  started_at: string;
  completed_at?: string;
  html_url: string;
  labels?: unknown;
  runner_id?: unknown;
  runner_name?: unknown;
  runner_group_id?: unknown;
  runner_group_name?: unknown;
}

interface GitHubRunJobsResponse {
  jobs: GitHubJobPayload[];
}

interface RunListValidator {
  workflowFile: string;
  windowStart: string;
  windowEnd: string;
  etag: string;
}

/** Extract the NPU model and card count from the repository's runner-label convention. */
export function parseRunnerResourceLabels(labels?: string[]): Pick<Job, 'resource_model' | 'resource_count'> {
  for (const label of labels ?? []) {
    const match = /^linux-aarch64-(.+)-([1-9]\d*)$/.exec(label);
    if (match) return { resource_model: `linux-aarch64-${match[1]}`, resource_count: Number(match[2]) };
  }
  return {};
}

interface RepoCollectionState {
  latest: string;
  collectedDates: string[];
  historyComplete: boolean;
  backfillCursor: string | undefined;
  retentionDays: number;
}

interface RunCollectionOptions {
  token?: string;
  tokens?: string[];
  retentionDays: number;
  cliOptions: CollectCliOptions;
  targetRepos: string[];
  reposConfig?: ReposConfig;
  octokit?: Octokit;
  collectRepoImpl?: typeof collectRepo;
}

interface CollectionWork {
  repo: string;
  window: CollectionWindow;
  priority: number;
}

const RATE_LIMIT_RESERVE = Number.parseInt(process.env.GITHUB_RATE_LIMIT_RESERVE ?? '10', 10);

function reserveRateLimitBudget(octokit: Octokit, remaining: number): Octokit {
  let budget = remaining;
  return {
    ...octokit,
    request: async (route: string, parameters?: Record<string, unknown>) => {
      if (budget <= RATE_LIMIT_RESERVE) {
        throw new RateLimitAbortError(`GitHub API budget reserve reached (remaining=${budget}, reserve=${RATE_LIMIT_RESERVE})`);
      }
      budget -= 1;
      const response = await octokit.request(route, parameters);
      const reported = Number(response.headers?.['x-ratelimit-remaining']);
      if (Number.isFinite(reported)) budget = reported;
      return response;
    },
  } as Octokit;
}


const ETL_DIR = path.join(__dirname, '..');
const REPOS_CONFIG_PATH = path.join(ETL_DIR, 'repos.yaml');

function readReposConfig(): ReposConfig {
  try {
    log(`Reading repos config from: ${REPOS_CONFIG_PATH}`);
    const content = fs.readFileSync(REPOS_CONFIG_PATH, 'utf-8');
    const config = parseReposConfig(content);
    log(`Found repos in repos.yaml: ${getRepoNames(config).join(', ')}`);
    return config;
  } catch {
    warn('Failed to read repos.yaml, falling back to environment variable');
    const envRepos = (process.env.TARGET_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
    log(`TARGET_REPOS env var: ${process.env.TARGET_REPOS || '(empty)'}`);
    return { repos: envRepos.map((repo) => ({ repo, workflows: [] })) };
  }
}

function findRepoConfig(config: ReposConfig, repo: string): RepoConfigEntry {
  return config.repos.find((entry) => entry.repo === repo) ?? { repo, workflows: [] };
}

function computeBackfillCursor(
  retainedDates: string[],
  retentionStart: string,
  today: string,
): { backfillCursor: string | undefined; historyComplete: boolean } {
  const availableDates = new Set(retainedDates);
  let cursor = parseISO(retentionStart);
  const todayDate = parseISO(today);
  let backfillCursor: string | undefined;

  while (cursor <= todayDate) {
    const date = format(cursor, 'yyyy-MM-dd');
    if (!availableDates.has(date)) {
      backfillCursor = date;
      break;
    }
    cursor = addDays(cursor, 1);
  }

  return {
    backfillCursor,
    historyComplete: !backfillCursor,
  };
}

async function loadRepoState(repo: string, collectDays: number, now: Date): Promise<RepoCollectionState> {
  const retentionStart = format(subDays(now, collectDays), 'yyyy-MM-dd');
  const today = format(now, 'yyyy-MM-dd');

  const dbState = await readCollectionState(repo);
  const collectedDates = await getCollectedDates(repo);

  const retainedDates = collectedDates.filter(d => d >= retentionStart);

  let backfillCursor: string | undefined;
  let historyComplete = dbState?.historyComplete ?? false;

  if (!historyComplete) {
    const savedCursor = dbState?.backfillCursor;
    if (savedCursor && savedCursor >= retentionStart && savedCursor <= today) {
      backfillCursor = savedCursor;
    } else {
      const result = computeBackfillCursor(retainedDates, retentionStart, today);
      backfillCursor = result.backfillCursor;
      historyComplete = result.historyComplete;
    }
  }

  return {
    latest: dbState?.latestDate && dbState.latestDate >= retentionStart ? dbState.latestDate : '',
    collectedDates: retainedDates,
    historyComplete,
    backfillCursor,
    retentionDays: dbState?.retentionDays ?? collectDays,
  };
}


export class RateLimitAbortError extends Error {
  partialRuns: Run[];
  details: RateLimitDetails;

  constructor(message: string, partialRuns: Run[] = [], details: RateLimitDetails = {}) {
    super(message);
    this.name = 'RateLimitAbortError';
    this.partialRuns = partialRuns;
    this.details = details;
  }
}

export class SaturatedCollectionWindowError extends Error {
  constructor(window: CollectionWindow) {
    super(`Collection window ${window.start}..${window.end} remains saturated at the minimum split size`);
    this.name = 'SaturatedCollectionWindowError';
  }
}

function runAttemptKey(runId: number, runAttempt: number | undefined): string {
  return `${runId}:${runAttempt ?? 1}`;
}

async function fetchAllJobPages(fetchPage: (page: number) => Promise<GitHubRunJobsResponse>): Promise<GitHubRunJobsResponse> {
  const jobs: GitHubJobPayload[] = [];
  for (let page = 1; ; page += 1) {
    const data = await fetchPage(page);
    jobs.push(...data.jobs);
    if (data.jobs.length < PER_PAGE) return { jobs };
  }
}

export async function fetchJobsForRunAttempt(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  runAttempt: number,
): Promise<GitHubRunJobsResponse> {
  if (runAttempt > 1) {
    try {
      return await fetchAllJobPages(async (page) => {
        const response = await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
          owner,
          repo,
          run_id: runId,
          attempt_number: runAttempt,
          per_page: PER_PAGE,
          page,
        }));
        return response.data as GitHubRunJobsResponse;
      });
    } catch (err) {
      const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
      if (status !== 404 && status !== 422) throw err;
    }
  }

  return fetchAllJobPages(async (page) => {
    const response = await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner,
      repo,
      run_id: runId,
      per_page: PER_PAGE,
      page,
    }));
    return response.data as GitHubRunJobsResponse;
  });
}

async function persistCollectedRuns(
  repo: string,
  state: RepoCollectionState,
  runs: Run[],
  retentionDays: number,
  reposConfig: ReposConfig,
  repoConfig: RepoConfigEntry,
  queriedWindows: CollectionWindow[] = [],
  now: Date = new Date(),
): Promise<RepoCollectionState> {
  const runsByDate: Record<string, Run[]> = {};
  for (const run of runs) {
    const date = format(new Date(run.created_at), 'yyyy-MM-dd');
    if (!runsByDate[date]) runsByDate[date] = [];
    runsByDate[date].push(run);
  }

  const dates = Object.keys(runsByDate).sort().reverse();
  if (dates.length > 0) {
    log(`Date range: ${dates[dates.length - 1]} to ${dates[0]} (${dates.length} days)`);
  } else {
    log('No completed runs found for this repo');
  }

  const queriedDates = new Set<string>();
  for (const window of queriedWindows) {
    let d = parseISO(window.start);
    const end = parseISO(window.end);
    while (d <= end) {
      queriedDates.add(format(d, 'yyyy-MM-dd'));
      d = addDays(d, 1);
    }
  }
  const existingDateSet = new Set(state.collectedDates);
  const emptyDates = Array.from(queriedDates).filter(date => !runsByDate[date] && !existingDateSet.has(date)).sort();

  const allDates = Array.from(new Set([...state.collectedDates, ...dates, ...emptyDates])).sort().reverse();

  const batches = dates.map((date) => {
    const runsForDate = runsByDate[date];
    console.log(`  Writing ${date} (${runsForDate.length} runs)`);
    return {
      date,
      runs: runsForDate,
      attempts: buildWorkflowAttempts(runsForDate, reposConfig, repoConfig),
    };
  });

  const cutoffDate = startOfDay(subDays(now, retentionDays));
  const retainedDates = allDates.filter(d => !isBefore(parseISO(d), cutoffDate));

  const retentionStart = format(subDays(now, retentionDays), 'yyyy-MM-dd');
  const today = format(now, 'yyyy-MM-dd');
  const { backfillCursor, historyComplete } = computeBackfillCursor(retainedDates, retentionStart, today);

  const newState: RepoCollectionState = {
    latest: retainedDates[0] || state.latest || '',
    collectedDates: retainedDates,
    historyComplete,
    backfillCursor,
    retentionDays,
  };

  await persistCollectionWindow(repo, batches, {
    backfillCursor: newState.backfillCursor ?? null,
    historyComplete: newState.historyComplete,
    latestDate: newState.latest || null,
    retentionDays: newState.retentionDays,
    lastUpdated: new Date().toISOString(),
  });
  console.log(`  State updated: ${retainedDates.length} dates, latest: ${newState.latest}`);
  return newState;
}

export async function collectRepo(
  octokit: Octokit,
  repo: string,
  retentionDays: number,
  options: CollectCliOptions,
  reposConfig: ReposConfig = { repos: [{ repo, workflows: [] }] },
  plannedWindows?: CollectionWindow[],
) {
  console.log(`Processing ${repo}...`);
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  }

  log(`Owner: ${owner}, Repo: ${repoName}`);
  const repoConfig = findRepoConfig(reposConfig, repo);

  const now = new Date();
  const effectiveDays = options.collectDays ?? retentionDays;
  if (options.collectDays) {
    log(`Collecting most recent ${options.collectDays} day(s) (retention still ${retentionDays} day(s))`);
  }
  let state = await loadRepoState(repo, effectiveDays, now);
  log(`State: latest=${state.latest || '(none)'}, dates=${state.collectedDates.length}, historyComplete=${state.historyComplete}`);

  // GitHub accepts a workflow filename in the workflow_id route segment, so
  // use the configured stable identity directly instead of listing metadata.
  const trackedWorkflowIds = repoConfig.workflows.map(workflow => workflow.file);
  if (trackedWorkflowIds.length) console.log(`Collecting ${trackedWorkflowIds.length} tracked workflow(s) only.`);

  function toCreatedParam(window: CollectionWindow): string {
    return toCreatedRange(window);
  }

  const initialLatest = state.latest;

  function isRecentWindow(window: CollectionWindow): boolean {
    return Boolean(initialLatest) && !options.forceFullBackfill && window.end.slice(0, 10) >= initialLatest;
  }

  async function fetchRunsForWindow(window: CollectionWindow, workflowId?: string): Promise<{ runs: Run[]; saturated: boolean; unchanged: boolean; validator?: RunListValidator }> {
    const createdParam = toCreatedParam(window);
    log(`Fetching runs with filter: ${createdParam}`);

    const allRuns: Run[] = [];
    let page = 1;
    let totalFetched = 0;
    let validator: RunListValidator | undefined;
    const cachedEtag = workflowId && isRecentWindow(window)
      ? await readRunListValidator(repo, workflowId, window.start, window.end)
      : null;

    while (true) {
      log(`Fetching page ${page} for ${createdParam}...`);
      const startTime = Date.now();
      let data;
      try {
        const response = await withRetry(() => workflowId
          ? octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
            owner,
            repo: repoName,
            workflow_id: workflowId,
            per_page: PER_PAGE,
            page,
            created: createdParam,
            ...(page === 1 && cachedEtag ? { headers: { 'if-none-match': cachedEtag } } : {}),
          })
          : octokit.request('GET /repos/{owner}/{repo}/actions/runs', { owner, repo: repoName, per_page: PER_PAGE, page, created: createdParam })
        );
        data = response.data;
        const etag = page === 1 && typeof response.headers?.etag === 'string' ? response.headers.etag : undefined;
        if (workflowId && etag) {
          validator = { workflowFile: workflowId, windowStart: window.start, windowEnd: window.end, etag };
        }
      } catch (err) {
        const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
        if (status === 304 && page === 1 && cachedEtag) {
          log(`Run list unchanged for ${workflowId} ${createdParam}`);
          return { runs: [], saturated: false, unchanged: true };
        }
        if (isGitHubRateLimitError(err)) {
          const details = getRateLimitDetails(err);
          throw new RateLimitAbortError(
            `GitHub API rate limit reached (remaining=${details.remaining || 'unknown'}, limit=${details.limit || 'unknown'}, reset=${details.reset || 'unknown'})`,
            allRuns,
            details
          );
        }
        throw err;
      }
      const elapsed = Date.now() - startTime;
      log(`Page ${page}: ${data.workflow_runs.length} runs fetched (${elapsed}ms)`);

      if (data.workflow_runs.length === 0) {
        log('No more runs, breaking pagination');
        break;
      }

      for (const run of data.workflow_runs) {
        allRuns.push(enrichRunWithWorkflowMetadata({
          id: run.id, name: run.name ?? 'unknown', head_branch: run.head_branch ?? 'unknown',
          head_sha: typeof run.head_sha === 'string' ? run.head_sha : undefined,
          status: run.status ?? 'completed', conclusion: run.conclusion ?? 'unknown', event: run.event ?? 'unknown',
          created_at: run.created_at, run_started_at: typeof run.run_started_at === 'string' ? run.run_started_at : undefined,
          updated_at: run.updated_at, html_url: run.html_url,
          durationInSeconds: (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
          pull_requests: readPullRequestsFromPayload(run as GitHubApiPayload), jobs: [], githubPayload: run as GitHubApiPayload,
        }, reposConfig, repoConfig));
      }

      totalFetched += data.workflow_runs.length;
      log(`Page ${page} summary: ${data.workflow_runs.length} run(s) listed (total fetched: ${totalFetched})`);

      if (data.workflow_runs.length < PER_PAGE) {
        log('Last page reached (< per_page)');
        break;
      }

      if (page >= MAX_RESULTS_PER_QUERY / PER_PAGE) {
        warn(`Window ${createdParam} appears capped at ${MAX_RESULTS_PER_QUERY} results`);
        return { runs: allRuns, saturated: true, unchanged: false, validator };
      }

      page++;
      log('Waiting 1s before next page...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { runs: allRuns, saturated: false, unchanged: false, validator };
  }

  function normalizeJobs(jobsData: GitHubRunJobsResponse): Job[] {
    return jobsData.jobs.map(j => {
      const startedMs = new Date(j.started_at).getTime();
      const createdMs = j.created_at ? new Date(j.created_at).getTime() : startedMs;
      const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : startedMs;
      const labels = Array.isArray(j.labels) && j.labels.every((label): label is string => typeof label === 'string') ? j.labels : undefined;
      const steps = Array.isArray(j.steps) ? j.steps.flatMap((rawStep, index) => {
        if (!rawStep || typeof rawStep !== 'object') return [];
        const step = rawStep as Record<string, unknown>;
        const started_at = typeof step.started_at === 'string' ? step.started_at : undefined;
        const completed_at = typeof step.completed_at === 'string' ? step.completed_at : undefined;
        return [{ name: typeof step.name === 'string' ? step.name : `Step ${index + 1}`, status: typeof step.status === 'string' ? step.status : 'unknown', conclusion: typeof step.conclusion === 'string' ? step.conclusion : 'unknown', started_at, completed_at, number: typeof step.number === 'number' ? step.number : index + 1, duration_seconds: started_at && completed_at ? Math.max(0, Math.floor((new Date(completed_at).getTime() - new Date(started_at).getTime()) / 1000)) : 0 }];
      }) : undefined;
      return { id: j.id, name: j.name, status: j.status, conclusion: j.conclusion ?? 'unknown', created_at: j.created_at ?? new Date().toISOString(), started_at: j.started_at, completed_at: j.completed_at ?? new Date().toISOString(), html_url: j.html_url, queueDurationInSeconds: Math.max(0, (startedMs - createdMs) / 1000), durationInSeconds: Math.max(0, (completedMs - startedMs) / 1000), runtimeInSeconds: Math.max(0, (completedMs - startedMs) / 1000), totalDurationInSeconds: Math.max(0, (completedMs - createdMs) / 1000), labels, runner_id: typeof j.runner_id === 'number' ? j.runner_id : undefined, runner_name: typeof j.runner_name === 'string' ? j.runner_name : undefined, runner_group_id: typeof j.runner_group_id === 'number' ? j.runner_group_id : undefined, runner_group_name: typeof j.runner_group_name === 'string' ? j.runner_group_name : undefined, ...parseRunnerResourceLabels(labels), githubPayload: j, steps: steps?.length ? steps : undefined };
    });
  }

  async function hydrateRunsWithJobs(runs: Run[]): Promise<Run[]> {
    if (options.skipJobs) return runs;
    const hasWorkflowRules = repoConfig.workflows.length > 0;
    const candidates = runs.filter(run => !hasWorkflowRules || run.tracked).map(run => ({ runId: run.id, runAttempt: run.runAttempt ?? 1 }));
    const cached = await getCachedWorkflowAttempts(repo, candidates);
    log(`Candidate cached workflow attempts: ${cached.size}/${candidates.length}`);
    for (const run of runs) {
      if (hasWorkflowRules && !run.tracked) continue;
      const cachedAttempt = cached.get(runAttemptKey(run.id, run.runAttempt));
      const fresh = run.status === 'completed' && cachedAttempt?.stepPolicyHash === run.stepPolicyHash && Date.parse(cachedAttempt.updatedAt) >= Date.parse(run.updated_at);
      if (fresh) continue;
      try {
        run.jobs = normalizeJobs(await fetchJobsForRunAttempt(octokit, owner, repoName, run.id, run.runAttempt ?? 1));
      } catch (err) {
        if (isGitHubRateLimitError(err)) {
          const details = getRateLimitDetails(err);
          throw new RateLimitAbortError(`GitHub API rate limit reached (remaining=${details.remaining || 'unknown'}, limit=${details.limit || 'unknown'}, reset=${details.reset || 'unknown'})`, runs, details);
        }
        throw err;
      }
    }
    return runs;
  }

  async function collectRunsForWindow(window: CollectionWindow, workflowId?: string): Promise<{ runs: Run[]; unchanged: boolean; validators: RunListValidator[] }> {
    const { runs, saturated, unchanged, validator } = await fetchRunsForWindow(window, workflowId);
    if (!saturated) {
      return { runs, unchanged, validators: validator ? [validator] : [] };
    }

    const childWindows = splitCollectionWindow(window);
    if (childWindows.length === 0) {
      throw new SaturatedCollectionWindowError(window);
    }

    console.log(`Splitting saturated window (${window.start}..${window.end}) into ${childWindows.length} sub-windows`);
    const mergedRuns = new Map<string, Run>();
    const validators: RunListValidator[] = [];

    for (const childWindow of childWindows) {
      try {
        const childResult = await collectRunsForWindow(childWindow, workflowId);
        validators.push(...childResult.validators);
        for (const run of childResult.runs) {
          mergedRuns.set(runAttemptKey(run.id, run.runAttempt), run);
        }
      } catch (err) {
        if (err instanceof RateLimitAbortError) {
          for (const run of err.partialRuns) {
            mergedRuns.set(runAttemptKey(run.id, run.runAttempt), run);
          }

          throw new RateLimitAbortError(err.message, Array.from(mergedRuns.values()), err.details);
        }

        throw err;
      }
    }

    return { runs: Array.from(mergedRuns.values()), unchanged: false, validators };
  }

  const windows = plannedWindows ?? buildCollectionWindows({
    latest: state.latest,
    existingFileCount: state.collectedDates.length,
    historyComplete: state.historyComplete,
    backfillCursor: state.backfillCursor,
    retentionDays: effectiveDays,
    forceFullBackfill: options.forceFullBackfill,
    reverse: options.reverse,
  });
  const rangeStart = windows.length > 0 ? windows[windows.length - 1].start : '(?)';
  const rangeEnd = windows.length > 0 ? windows[0].end : '(?)';
  console.log(`Collecting ${windows.length} window(s) for ${repo} (${rangeStart} → ${rangeEnd})`);

  const allRunsMap = new Map<string, Run>();
  for (let wi = 0; wi < windows.length; wi += 1) {
    const window = windows[wi];
    console.log(`Window ${wi + 1}/${windows.length} (${window.start}..${window.end})`);
    try {
      const results: Awaited<ReturnType<typeof collectRunsForWindow>>[] = [];
      if (trackedWorkflowIds.length) {
        for (const workflowId of trackedWorkflowIds) {
          results.push(await collectRunsForWindow(window, workflowId));
        }
      } else {
        results.push(await collectRunsForWindow(window));
      }
      const changedResults = results.filter(result => !result.unchanged);
      if (changedResults.length === 0) {
        console.log(`Window ${wi + 1}/${windows.length} unchanged; skipped writes and jobs.`);
        continue;
      }

      const listedRuns = changedResults.flatMap(result => result.runs);
      const deduplicatedRuns = Array.from(new Map(listedRuns.map(run => [runAttemptKey(run.id, run.runAttempt), run])).values());
      const windowRuns = await hydrateRunsWithJobs(deduplicatedRuns);
      console.log(`Window ${wi + 1}/${windows.length} done: ${windowRuns.length} run(s)`);
      for (const run of windowRuns) {
        allRunsMap.set(runAttemptKey(run.id, run.runAttempt), run);
      }
      const checkpointState = await persistCollectedRuns(
        repo,
        state,
        windowRuns,
        retentionDays,
        reposConfig,
        repoConfig,
        [window],
        now,
      );
      state = checkpointState;
      for (const validator of changedResults.flatMap(result => result.validators)) {
        await writeRunListValidator(repo, validator.workflowFile, validator.windowStart, validator.windowEnd, validator.etag);
      }
      console.log(`Checkpointed ${repo}: ${checkpointState.collectedDates.length} retained date(s), latest=${checkpointState.latest || '(none)'} (${wi + 1}/${windows.length})`);
    } catch (err) {
      if (err instanceof RateLimitAbortError) {
        for (const run of err.partialRuns) {
          allRunsMap.set(runAttemptKey(run.id, run.runAttempt), run);
        }
        log(`Deferred incomplete ${repo} window ${wi + 1}/${windows.length}; no checkpoint was advanced.`);
      }
      throw err;
    }
  }

  log(`Total workflow attempts collected: ${allRunsMap.size}`);
}

async function buildCollectionPlan(
  targetRepos: string[],
  retentionDays: number,
  cliOptions: CollectCliOptions,
): Promise<CollectionWork[]> {
  const now = new Date();
  const effectiveDays = cliOptions.collectDays ?? retentionDays;
  const work: CollectionWork[] = [];

  for (const repo of targetRepos) {
    const state = await loadRepoState(repo, effectiveDays, now);
    const windows = buildCollectionWindows({
      latest: state.latest,
      existingFileCount: state.collectedDates.length,
      historyComplete: state.historyComplete,
      backfillCursor: state.backfillCursor,
      retentionDays: effectiveDays,
      forceFullBackfill: cliOptions.forceFullBackfill,
      reverse: cliOptions.reverse,
    });
    const newestWindowEnd = windows.reduce((newest, window) => window.end > newest ? window.end : newest, '');
    windows.forEach(window => work.push({ repo, window, priority: window.end === newestWindowEnd ? 0 : 1 }));
  }

  // Fresh work must complete for every Tracked Repository before backfill.
  return work.sort((a, b) => a.priority - b.priority);
}

export async function runSharedCollectionPlan({
  tokens,
  work,
  retentionDays,
  cliOptions,
  reposConfig,
  collectRepoImpl,
}: {
  tokens: string[];
  work: CollectionWork[];
  retentionDays: number;
  cliOptions: CollectCliOptions;
  reposConfig: ReposConfig;
  collectRepoImpl: typeof collectRepo;
}): Promise<{ failures: string[]; deferred: number }> {
  const identities = await Promise.all(tokens.map(async token => {
    const client = createOctokit(token);
    const identity = await getGitHubIdentity(client);
    const rateLimit = await client.request('GET /rate_limit');
    const data = rateLimit.data as { resources?: { core?: { remaining?: number } } };
    return { client: reserveRateLimitBudget(client, data.resources?.core?.remaining ?? 0), identity };
  }));
  const lanes = Array.from(new Map(identities.map(lane => [lane.identity, lane])).values());
  const pending = [...work];
  const activeRepos = new Set<string>();
  let activeRecent = 0;
  const failures: string[] = [];

  console.log(`GitHub identity lanes: ${lanes.length}; reserve: ${RATE_LIMIT_RESERVE}`);
  await Promise.all(lanes.map(async ({ client, identity }) => {
    while (true) {
      const index = pending.findIndex(unit => unit.priority === 0 && !activeRepos.has(unit.repo));
      const nextIndex = index >= 0
        ? index
        : activeRecent === 0
          ? pending.findIndex(unit => !activeRepos.has(unit.repo))
          : -1;
      if (nextIndex < 0) return;
      const unit = pending.splice(nextIndex, 1)[0];
      activeRepos.add(unit.repo);
      if (unit.priority === 0) activeRecent += 1;
      try {
        await collectRepoImpl(client, unit.repo, retentionDays, cliOptions, reposConfig, [unit.window]);
      } catch (err) {
        if (err instanceof RateLimitAbortError) {
          // This identity cannot safely spend its reserve. Leave the unit for another lane.
          pending.unshift(unit);
          console.warn(`Identity lane ${identity} deferred at its GitHub rate limit reserve.`);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${unit.repo}: ${message}`);
        error(`Failed to collect ${unit.repo}:`, err);
      } finally {
        activeRepos.delete(unit.repo);
        if (unit.priority === 0) activeRecent -= 1;
      }
    }
  }));

  if (pending.length > 0) {
    console.warn(`Deferred ${pending.length} collection window(s) because no identity lane remained available.`);
  }
  return { failures, deferred: pending.length };
}

export async function runCollection({
  token,
  tokens,
  retentionDays,
  cliOptions,
  targetRepos,
  reposConfig = { repos: targetRepos.map((repo) => ({ repo, workflows: [] })) },
  octokit,
  collectRepoImpl = collectRepo,
}: RunCollectionOptions) {
  const activeToken = tokens?.[0] ?? token;
  if (!activeToken) throw new Error('No GitHub token found. Add gh-token.txt or run gh auth login.');
  if (targetRepos.length === 0) {
    console.log('No repositories configured. Skipping collection.');
    return;
  }

  const client = octokit ?? createOctokit(activeToken);
  const failures: string[] = [];
  let stoppedEarly: RateLimitAbortError | null = null;

  if (cliOptions.forceFullBackfill) {
    console.log(
      `Force full backfill enabled; rebuilding up to ${retentionDays} days for ${cliOptions.repoName || 'all configured repos'}.`
    );
  }
  if (cliOptions.reverse) {
    console.log('Reverse collection enabled; starting from today and walking backward.');
  }
  if (cliOptions.skipJobs) {
    console.log('Workflow-only mode enabled; jobs will not be fetched in this pass.');
  }
  if (cliOptions.collectDays) {
    console.log(`Scoped collection: most recent ${cliOptions.collectDays} day(s) (data retention stays ${retentionDays} day(s)).`);
  }
  if (cliOptions.repoName) {
    console.log(`Single repo mode enabled; collecting only ${cliOptions.repoName}.`);
  }

  if (tokens && !octokit) {
    const work = await buildCollectionPlan(targetRepos, retentionDays, cliOptions);
    const scheduled = await runSharedCollectionPlan({
      tokens,
      work,
      retentionDays,
      cliOptions,
      reposConfig,
      collectRepoImpl,
    });
    if (scheduled.failures.length > 0) {
      throw new Error(`Collection failed for ${scheduled.failures.length} repos`);
    }
    if (scheduled.deferred > 0) {
      throw new Error(`Collection deferred for ${scheduled.deferred} window(s); no identity lane remained available`);
    }
    for (const repo of targetRepos) {
      const freshness = await checkEtlFreshness(repo);
      if (freshness) {
        const message = formatFreshnessReport(freshness, repo);
        if (freshness.isStale) console.warn(message);
        else log(message);
      }
    }
    console.log('Done!');
    return;
  }

  for (const repo of targetRepos) {
    try {
      await collectRepoImpl(client, repo, retentionDays, cliOptions, reposConfig);
    } catch (err) {
      if (err instanceof RateLimitAbortError) {
        stoppedEarly = err;
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${repo}: ${message}`);
      error(`Failed to collect ${repo}:`, err);
    }
  }

  if (stoppedEarly) {
    console.log(stoppedEarly.message);
    console.log('Stopping collection early. Partial results were saved and the next run can resume from the updated index.');
  }

  if (failures.length > 0) {
    error('Collection completed with failures:');
    for (const failure of failures) {
      error(`  - ${failure}`);
    }
    throw new Error(`Collection failed for ${failures.length} repos`);
  }

  if (stoppedEarly) {
    return;
  }

  for (const repo of targetRepos) {
    const freshness = await checkEtlFreshness(repo);
    if (freshness) {
      const message = formatFreshnessReport(freshness, repo);
      if (freshness.isStale) {
        console.warn(message);
      } else {
        log(message);
      }
    }
  }

  console.log('Done!');
}

export async function main() {
  const cliOptions = parseCollectCliOptions(process.argv.slice(2));

  if (cliOptions.help) {
    console.log(CLI_HELP);
    return;
  }

  const tokens = resolveGitHubTokens();
  const reposConfig = readReposConfig();
  const targetRepos = resolveTargetRepos(getRepoNames(reposConfig), cliOptions.repoName);
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90');

  log(`VERBOSE mode: ${VERBOSE}`);
  log(`Retention days: ${retentionDays}`);
  log(`Collect days: ${cliOptions.collectDays ?? '(full retention)'}`);
  log(`Force full backfill: ${cliOptions.forceFullBackfill}`);
  log(`Reverse collection: ${cliOptions.reverse}`);
  log(`Requested repo: ${cliOptions.repoName || '(all configured repos)'}`);
  log(`Target repos: ${targetRepos.join(', ') || '(none)'}`);
  log(`Node version: ${process.version}`);
  log(`ETL_DIR: ${ETL_DIR}`);
  log(`State storage: PostgreSQL`);
  log(`GitHub token lanes: ${tokens.length}`);

  await runCollection({
    tokens,
    retentionDays,
    cliOptions,
    targetRepos,
    reposConfig,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    error(err);
    process.exit(1);
  });
}
