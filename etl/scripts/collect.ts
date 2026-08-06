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
import { isGitHubRateLimitError, getRateLimitDetails, type RateLimitDetails } from './github.ts';
import {
  writeRunsToTurso,
  writeWorkflowAttemptsToTurso,
  getExistingRunIdsWithStepsFromTurso,
  readCollectionState,
  writeCollectionState,
  getCollectedDatesFromTurso,
  checkEtlFreshness,
  formatFreshnessReport,
} from './turso-storage.ts';
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
  retentionDays: number;
  cliOptions: CollectCliOptions;
  targetRepos: string[];
  reposConfig?: ReposConfig;
  octokit?: Octokit;
  collectRepoImpl?: typeof collectRepo;
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

async function loadRepoState(repo: string, retentionDays: number, now: Date): Promise<RepoCollectionState> {
  const retentionStart = format(subDays(now, retentionDays), 'yyyy-MM-dd');
  const today = format(now, 'yyyy-MM-dd');

  const dbState = await readCollectionState(repo);
  const collectedDates = await getCollectedDatesFromTurso(repo);

  const retainedDates = collectedDates.filter(d => d >= retentionStart);

  let backfillCursor: string | undefined;
  let historyComplete = dbState?.historyComplete ?? false;

  if (!historyComplete) {
    const result = computeBackfillCursor(retainedDates, retentionStart, today);
    backfillCursor = result.backfillCursor;
    historyComplete = result.historyComplete;
  }

  return {
    latest: dbState?.latestDate ?? '',
    collectedDates: retainedDates,
    historyComplete,
    backfillCursor,
    retentionDays: dbState?.retentionDays ?? retentionDays,
  };
}

async function saveRepoState(repo: string, state: RepoCollectionState): Promise<void> {
  const statePayload = {
    backfillCursor: state.backfillCursor ?? null,
    historyComplete: state.historyComplete,
    latestDate: state.latest || null,
    retentionDays: state.retentionDays,
    lastUpdated: new Date().toISOString(),
  };

  await writeCollectionState(repo, statePayload);
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

  for (const date of dates) {
    const runCount = runsByDate[date].length;
    console.log(`  Writing ${date} (${runCount} runs)`);

    await writeRunsToTurso(repo, runsByDate[date], date);

    const attempts = buildWorkflowAttempts(runsByDate[date], reposConfig, repoConfig);
    await writeWorkflowAttemptsToTurso(repo, attempts);
  }

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

  await saveRepoState(repo, newState);
  console.log(`  State updated: ${retainedDates.length} dates, latest: ${newState.latest}`);
  return newState;
}

export async function collectRepo(
  octokit: Octokit,
  repo: string,
  retentionDays: number,
  options: CollectCliOptions,
  reposConfig: ReposConfig = { repos: [{ repo, workflows: [] }] },
) {
  console.log(`Processing ${repo}...`);
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  }

  log(`Owner: ${owner}, Repo: ${repoName}`);
  const repoConfig = findRepoConfig(reposConfig, repo);

  const now = new Date();
  let state = await loadRepoState(repo, retentionDays, now);
  log(`State: latest=${state.latest}, dates=${state.collectedDates.length}, historyComplete=${state.historyComplete}`);

  const existingRunIdsWithSteps = await getExistingRunIdsWithStepsFromTurso(repo);
  const cachedRunIdsWithSteps = options.skipJobs ? new Map<number, string>() : existingRunIdsWithSteps;
  log(`Existing runs with cached steps: ${cachedRunIdsWithSteps.size}`);

  function toCreatedParam(window: CollectionWindow): string {
    return toCreatedRange(window);
  }

  async function fetchRunsForWindow(window: CollectionWindow): Promise<{ runs: Run[]; saturated: boolean }> {
    const createdParam = toCreatedParam(window);
    log(`Fetching runs with filter: ${createdParam}`);

    const allRuns: Run[] = [];
    let page = 1;
    let totalFetched = 0;
    let skippedJobsCount = 0;

    while (true) {
      log(`Fetching page ${page} for ${createdParam}...`);
      const startTime = Date.now();
      let data;
      try {
        const response = await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
          owner,
          repo: repoName,
          per_page: PER_PAGE,
          page,
          created: createdParam,
        }));
        data = response.data;
      } catch (err) {
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

      let persistedCount = 0;

      for (const run of data.workflow_runs) {
        const runId = run.id;
        let jobs: Job[] = [];
        const baseRun: Run = enrichRunWithWorkflowMetadata({
          id: run.id,
          name: run.name ?? 'unknown',
          head_branch: run.head_branch ?? 'unknown',
          head_sha: typeof run.head_sha === 'string' ? run.head_sha : undefined,
          status: run.status ?? 'completed',
          conclusion: run.conclusion ?? 'unknown',
          event: run.event ?? 'unknown',
          created_at: run.created_at,
          run_started_at: typeof run.run_started_at === 'string' ? run.run_started_at : undefined,
          updated_at: run.updated_at,
          html_url: run.html_url,
          durationInSeconds: (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
          pull_requests: readPullRequestsFromPayload(run as GitHubApiPayload),
          jobs: [],
          githubPayload: run as GitHubApiPayload,
        }, reposConfig, repoConfig);
        persistedCount++;

        const cachedUpdatedAt = cachedRunIdsWithSteps.get(runId);
        const isCachedRunFresh =
          !!cachedUpdatedAt && Date.parse(cachedUpdatedAt) >= Date.parse(run.updated_at);
        const hasWorkflowRules = repoConfig.workflows.length > 0;
        const supportsStepsCache = baseRun.runAttempt === 1 && baseRun.status === 'completed';

        if (options.skipJobs) {
          log(`Skipping jobs for run #${runId} - workflow-only mode`);
        } else if (hasWorkflowRules && !baseRun.tracked) {
          skippedJobsCount++;
          log(`Skipping jobs for run #${runId} - workflow is not tracked (${baseRun.workflowParseStatus ?? 'unknown'})`);
        } else if (supportsStepsCache && isCachedRunFresh) {
          skippedJobsCount++;
          log(`Skipping jobs for run #${runId} - already cached with steps`);
        } else {
          log(`Fetching jobs for run #${runId} attempt ${baseRun.runAttempt ?? 1} (${run.name})...`);
          const jobsStartTime = Date.now();
          let jobsData: GitHubRunJobsResponse;
          try {
            jobsData = await fetchJobsForRunAttempt(octokit, owner, repoName, runId, baseRun.runAttempt ?? 1);
          } catch (err) {
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
          const jobsElapsed = Date.now() - jobsStartTime;
          log(`Jobs for run #${runId}: ${jobsData.jobs.length} jobs (${jobsElapsed}ms)`);

          jobs = (jobsData.jobs as GitHubJobPayload[]).map(j => {
            const startedMs = new Date(j.started_at).getTime();
            const createdMs = j.created_at ? new Date(j.created_at).getTime() : startedMs;
            const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : startedMs;

            // Extract steps from the job payload
            const steps: Step[] = [];
            const rawSteps = (j.steps as Record<string, unknown>[] | undefined);
            if (Array.isArray(rawSteps)) {
              for (const [index, rawStep] of rawSteps.entries()) {
                if (!rawStep || typeof rawStep !== 'object') continue;
                const s = rawStep as Record<string, unknown>;
                const stepStartedAt = typeof s.started_at === 'string' ? s.started_at : null;
                const stepCompletedAt = typeof s.completed_at === 'string' ? s.completed_at : null;
                let stepDuration = 0;
                if (stepStartedAt && stepCompletedAt) {
                  const startMs = new Date(stepStartedAt).getTime();
                  const completedMs = new Date(stepCompletedAt).getTime();
                  if (!isNaN(startMs) && !isNaN(completedMs)) {
                    stepDuration = Math.max(0, Math.floor((completedMs - startMs) / 1000));
                  }
                }
                const stepNumber = typeof s.number === 'number' ? s.number : index + 1;
                steps.push({
                  name: (s.name as string) || `Step ${index + 1}`,
                  status: (s.status as string) || 'unknown',
                  conclusion: (s.conclusion as string) || 'unknown',
                  started_at: stepStartedAt || undefined,
                  completed_at: stepCompletedAt || undefined,
                  number: stepNumber,
                  duration_seconds: stepDuration,
                });
              }
            }

            const labels = Array.isArray(j.labels) && j.labels.every((label): label is string => typeof label === 'string')
              ? j.labels
              : undefined;

            return {
              id: j.id,
              name: j.name,
              status: j.status,
              conclusion: j.conclusion ?? 'unknown',
              created_at: j.created_at ?? new Date().toISOString(),
              started_at: j.started_at,
              completed_at: j.completed_at ?? new Date().toISOString(),
              html_url: j.html_url,
              queueDurationInSeconds: Math.max(0, (startedMs - createdMs) / 1000),
              durationInSeconds: Math.max(0, (completedMs - startedMs) / 1000),
              runtimeInSeconds: Math.max(0, (completedMs - startedMs) / 1000),
              totalDurationInSeconds: Math.max(0, (completedMs - createdMs) / 1000),
              labels,
              runner_id: typeof j.runner_id === 'number' ? j.runner_id : undefined,
              runner_name: typeof j.runner_name === 'string' ? j.runner_name : undefined,
              runner_group_id: typeof j.runner_group_id === 'number' ? j.runner_group_id : undefined,
              runner_group_name: typeof j.runner_group_name === 'string' ? j.runner_group_name : undefined,
              ...parseRunnerResourceLabels(labels),
              githubPayload: j,
              steps: steps.length > 0 ? steps : undefined,
            };
          });
        }

        allRuns.push({
          ...baseRun,
          jobs,
        });
      }

      totalFetched += data.workflow_runs.length;
      log(`Page ${page} summary: ${persistedCount} persisted, ${skippedJobsCount} jobs cached/skipped (total fetched: ${totalFetched})`);

      if (data.workflow_runs.length < PER_PAGE) {
        log('Last page reached (< per_page)');
        break;
      }

      if (page >= MAX_RESULTS_PER_QUERY / PER_PAGE) {
        warn(`Window ${createdParam} appears capped at ${MAX_RESULTS_PER_QUERY} results`);
        return { runs: allRuns, saturated: true };
      }

      page++;
      log('Waiting 1s before next page...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { runs: allRuns, saturated: false };
  }

  async function collectRunsForWindow(window: CollectionWindow): Promise<Run[]> {
    const { runs, saturated } = await fetchRunsForWindow(window);
    if (!saturated) {
      return runs;
    }

    const childWindows = splitCollectionWindow(window);
    if (childWindows.length === 0) {
      warn(`Window ${JSON.stringify(window)} cannot be split further; keeping partial result set`);
      return runs;
    }

    log(`Splitting saturated window ${JSON.stringify(window)} into ${childWindows.length} sub-windows`);
    const mergedRuns = new Map<string, Run>();

    for (const childWindow of childWindows) {
      try {
        const childRuns = await collectRunsForWindow(childWindow);
        for (const run of childRuns) {
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

    return Array.from(mergedRuns.values());
  }

  const windows = buildCollectionWindows({
    latest: state.latest,
    existingFileCount: state.collectedDates.length,
    historyComplete: state.historyComplete,
    backfillCursor: state.backfillCursor,
    retentionDays,
    forceFullBackfill: options.forceFullBackfill,
    reverse: options.reverse,
  });
  log(`Collecting ${windows.length} window(s) for ${repo}`);

  const allRunsMap = new Map<string, Run>();
  const completedWindows: CollectionWindow[] = [];
  for (const window of windows) {
    try {
      const windowRuns = await collectRunsForWindow(window);
      for (const run of windowRuns) {
        allRunsMap.set(runAttemptKey(run.id, run.runAttempt), run);
      }
      completedWindows.push(window);

      const checkpointState = await persistCollectedRuns(
        repo,
        state,
        Array.from(allRunsMap.values()),
        retentionDays,
        reposConfig,
        repoConfig,
        completedWindows,
        now,
      );
      state = checkpointState;
      log(`Checkpointed partial raw collection state for ${repo}: ${checkpointState.collectedDates.length} retained date(s).`);
    } catch (err) {
      if (err instanceof RateLimitAbortError) {
        for (const run of err.partialRuns) {
          allRunsMap.set(runAttemptKey(run.id, run.runAttempt), run);
        }
        const persistedState = await persistCollectedRuns(
          repo,
          state,
          Array.from(allRunsMap.values()),
          retentionDays,
          reposConfig,
          repoConfig,
          completedWindows,
          now,
        );
        log(`Persisted partial raw collection state for ${repo}: ${persistedState.collectedDates.length} retained date(s).`);
      }
      throw err;
    }
  }

  const allRuns = Array.from(allRunsMap.values());
  log(`Total workflow attempts collected: ${allRuns.length}`);
  await persistCollectedRuns(repo, state, allRuns, retentionDays, reposConfig, repoConfig, completedWindows, now);
}

export async function runCollection({
  token,
  retentionDays,
  cliOptions,
  targetRepos,
  reposConfig = { repos: targetRepos.map((repo) => ({ repo, workflows: [] })) },
  octokit,
  collectRepoImpl = collectRepo,
}: RunCollectionOptions) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (targetRepos.length === 0) {
    console.log('No repositories configured. Skipping collection.');
    return;
  }

  const client = octokit ?? new Octokit({ auth: token });
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
  if (cliOptions.repoName) {
    console.log(`Single repo mode enabled; collecting only ${cliOptions.repoName}.`);
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

  const token = process.env.GITHUB_TOKEN;
  const reposConfig = readReposConfig();
  const targetRepos = resolveTargetRepos(getRepoNames(reposConfig), cliOptions.repoName);
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90');

  log(`VERBOSE mode: ${VERBOSE}`);
  log(`Retention days: ${retentionDays}`);
  log(`Force full backfill: ${cliOptions.forceFullBackfill}`);
  log(`Reverse collection: ${cliOptions.reverse}`);
  log(`Requested repo: ${cliOptions.repoName || '(all configured repos)'}`);
  log(`Target repos: ${targetRepos.join(', ') || '(none)'}`);
  log(`Node version: ${process.version}`);
  log(`ETL_DIR: ${ETL_DIR}`);
  log(`State storage: PostgreSQL`);

  await runCollection({
    token,
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
