// ETL script: fetches GitHub Actions runs/jobs and writes daily JSON files
import { Octokit } from '@octokit/core';
import { format, subDays, parseISO, isBefore } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'url';

import {
  parseCollectCliOptions,
  resolveTargetRepos,
  type CollectCliOptions,
} from './collect-options.ts';
import collectionWindows, { type CollectionWindow } from '../../src/lib/collection-windows.ts';

const { buildCollectionWindows, mergeCollectedDates, splitCollectionWindow, toCreatedRange } = collectionWindows;

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

interface Run {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  jobs?: Job[];
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
}

interface GitHubJobPayload {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  created_at?: string;
  started_at: string;
  completed_at?: string;
  html_url: string;
}

interface Index {
  version: number;
  latest: string;
  files: string[];
  retention_days: number;
  last_updated: string;
  history_complete?: boolean;
}

interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

interface ReposConfig {
  repos: string[];
}

interface StorageAdapter {
  readIndex: (repo: string) => Index;
  writeIndex: (repo: string, index: Index) => void;
  readDayData: (repo: string, date: string) => DayData;
  writeDayData: (repo: string, data: DayData) => void;
  deleteDayData: (repo: string, date: string) => void;
}

interface RunCollectionOptions {
  token?: string;
  retentionDays: number;
  cliOptions: CollectCliOptions;
  targetRepos: string[];
  octokit?: Octokit;
  collectRepoImpl?: typeof collectRepo;
}

interface RateLimitDetails {
  limit?: string;
  remaining?: string;
  reset?: string;
}

type GitHubRequestErrorLike = {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | number | undefined>;
    data?: { message?: string };
  };
};

const ETL_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '../../data');
const REPOS_CONFIG_PATH = path.join(ETL_DIR, 'repos.yaml');

function getRepoDir(repo: string): string {
  const [owner, name] = repo.split('/');
  return path.join(DATA_DIR, owner, name);
}

function getIndexPath(repo: string): string {
  return path.join(getRepoDir(repo), 'index.json');
}

function readIndex(repo: string): Index {
  const indexPath = getIndexPath(repo);
  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const data = JSON.parse(content);
    if (data.repos && data.repos[repo]) {
      return {
        version: 1,
        latest: data.repos[repo].latest,
        files: data.repos[repo].files,
        retention_days: data.repos[repo].retention_days,
        last_updated: data.last_updated,
      };
    }
    return data;
  } catch {
    log('No existing index found, starting fresh');
    return { version: 1, latest: '', files: [], retention_days: 90, last_updated: '' };
  }
}

function writeIndex(repo: string, index: Index) {
  const repoDir = getRepoDir(repo);
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }
  fs.writeFileSync(getIndexPath(repo), JSON.stringify(index, null, 2));
  log(`Index written for ${repo}`);
}

function readReposConfig(): string[] {
  try {
    log(`Reading repos config from: ${REPOS_CONFIG_PATH}`);
    const content = fs.readFileSync(REPOS_CONFIG_PATH, 'utf-8');
    const config = yaml.load(content) as ReposConfig;
    log(`Found repos in repos.yaml: ${config.repos?.join(', ')}`);
    return config.repos || [];
  } catch {
    warn('Failed to read repos.yaml, falling back to environment variable');
    const envRepos = (process.env.TARGET_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
    log(`TARGET_REPOS env var: ${process.env.TARGET_REPOS || '(empty)'}`);
    return envRepos;
  }
}

function readDayData(repo: string, date: string): DayData {
  const filePath = path.join(getRepoDir(repo), `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { date, repo, runs: [] };
  }
}

function writeDayData(repo: string, data: DayData) {
  const repoDir = getRepoDir(repo);
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }
  const filePath = path.join(repoDir, `${data.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  log(`Day data written: ${filePath}`);
}

function deleteDayData(repo: string, date: string) {
  const filePath = path.join(getRepoDir(repo), `${date}.json`);
  if (!fs.existsSync(filePath)) {
    return;
  }

  fs.unlinkSync(filePath);
  log(`Day data removed: ${filePath}`);
}

function getRateLimitDetails(error: GitHubRequestErrorLike): RateLimitDetails {
  return {
    limit: String(error.response?.headers?.['x-ratelimit-limit'] ?? ''),
    remaining: String(error.response?.headers?.['x-ratelimit-remaining'] ?? ''),
    reset: String(error.response?.headers?.['x-ratelimit-reset'] ?? ''),
  };
}

export function isGitHubRateLimitError(error: unknown): error is GitHubRequestErrorLike {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as GitHubRequestErrorLike;
  const message = `${candidate.message ?? ''} ${candidate.response?.data?.message ?? ''}`.toLowerCase();
  const { remaining } = getRateLimitDetails(candidate);
  const retryAfter = candidate.response?.headers?.['retry-after'];
  const hasSecondaryRateLimitSignal =
    message.includes('secondary rate limit') ||
    message.includes('abuse detection') ||
    message.includes('abuse rate limit') ||
    (Boolean(retryAfter) && candidate.status === 403);

  return (
    remaining === '0' ||
    message.includes('rate limit') ||
    message.includes('api rate limit exceeded') ||
    hasSecondaryRateLimitSignal
  );
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

function persistCollectedRuns(
  storage: StorageAdapter,
  repo: string,
  index: Index,
  runs: Run[],
  retentionDays: number,
  historyComplete: boolean
): void {
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

  const files = mergeCollectedDates(index.files, dates);

  for (const date of dates) {
    console.log(`  Writing ${date}.json (${runsByDate[date].length} runs)`);
    const existing = storage.readDayData(repo, date);
    const runMap = new Map(existing.runs.map(r => [r.id, r]));
    for (const run of runsByDate[date]) {
      runMap.set(run.id, run);
    }

    storage.writeDayData(repo, { date, repo, runs: Array.from(runMap.values()) });
  }

  const updatedIndex: Index = {
    version: 1,
    latest: '',
    files,
    retention_days: retentionDays,
    last_updated: new Date().toISOString(),
    history_complete: historyComplete,
  };

  const cutoffDate = subDays(new Date(), retentionDays);
  const filesToRemove = files.filter(file => {
    const fileDate = parseISO(file.replace('.json', ''));
    return isBefore(fileDate, cutoffDate);
  });

  if (filesToRemove.length > 0) {
    log(`Removing ${filesToRemove.length} old files`);
  }

  for (const file of filesToRemove) {
    console.log(`  Removing old file: ${file}`);
    storage.deleteDayData(repo, file.replace('.json', ''));
    const idx = updatedIndex.files.indexOf(file);
    if (idx > -1) updatedIndex.files.splice(idx, 1);
  }

  updatedIndex.latest = updatedIndex.files[0]?.replace('.json', '') || index.latest || '';

  storage.writeIndex(repo, updatedIndex);
  console.log(`  Index updated: ${updatedIndex.files.length} files, latest: ${updatedIndex.latest}`);
}

export async function collectRepo(
  octokit: Octokit,
  repo: string,
  retentionDays: number,
  options: CollectCliOptions,
  storage: StorageAdapter = {
    readIndex,
    writeIndex,
    readDayData,
    writeDayData,
    deleteDayData,
  }
) {
  console.log(`Processing ${repo}...`);
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  }

  log(`Owner: ${owner}, Repo: ${repoName}`);

  const index = storage.readIndex(repo);
  log(`Index state: latest=${index.latest}, files=${index.files.length}`);

  function toCreatedParam(window: CollectionWindow): string {
    return `created:${toCreatedRange(window)}`;
  }

  async function fetchRunsForWindow(window: CollectionWindow): Promise<{ runs: Run[]; saturated: boolean }> {
    const createdParam = toCreatedParam(window);
    log(`Fetching runs with filter: ${createdParam}`);

    const allRuns: Run[] = [];
    let page = 1;
    let totalFetched = 0;

    while (true) {
      log(`Fetching page ${page} for ${createdParam}...`);
      const startTime = Date.now();
      let data;
      try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
          owner,
          repo: repoName,
          per_page: PER_PAGE,
          page,
          created: createdParam,
        });
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

      let completedCount = 0;
      let skippedCount = 0;

      for (const run of data.workflow_runs) {
        if (run.status !== 'completed') {
          skippedCount++;
          log(`Skipping run #${run.id} (${run.name}) - status: ${run.status}`);
          continue;
        }
        completedCount++;

        log(`Fetching jobs for run #${run.id} (${run.name})...`);
        const jobsStartTime = Date.now();
        let jobsData;
        try {
          const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
            owner,
            repo: repoName,
            run_id: run.id,
          });
          jobsData = response.data;
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
        log(`Jobs for run #${run.id}: ${jobsData.jobs.length} jobs (${jobsElapsed}ms)`);

        const jobs: Job[] = (jobsData.jobs as GitHubJobPayload[]).map(j => {
          const createdMs = j.created_at ? new Date(j.created_at).getTime() : 0;
          const startedMs = j.started_at ? new Date(j.started_at).getTime() : createdMs;
          const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : startedMs;
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
          };
        });

        allRuns.push({
          id: run.id,
          name: run.name ?? 'unknown',
          head_branch: run.head_branch ?? 'unknown',
          status: run.status ?? 'completed',
          conclusion: run.conclusion ?? 'unknown',
          created_at: run.created_at,
          updated_at: run.updated_at,
          html_url: run.html_url,
          durationInSeconds: (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
          jobs,
        });
      }

      totalFetched += data.workflow_runs.length;
      log(`Page ${page} summary: ${completedCount} completed, ${skippedCount} skipped (total fetched: ${totalFetched})`);

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
    const mergedRuns = new Map<number, Run>();

    for (const childWindow of childWindows) {
      try {
        const childRuns = await collectRunsForWindow(childWindow);
        for (const run of childRuns) {
          mergedRuns.set(run.id, run);
        }
      } catch (err) {
        if (err instanceof RateLimitAbortError) {
          for (const run of err.partialRuns) {
            mergedRuns.set(run.id, run);
          }

          throw new RateLimitAbortError(err.message, Array.from(mergedRuns.values()), err.details);
        }

        throw err;
      }
    }

    return Array.from(mergedRuns.values());
  }

  const windows = buildCollectionWindows({
    latest: index.latest,
    existingFileCount: index.files.length,
    historyComplete: index.history_complete,
    retentionDays,
    forceFullBackfill: options.forceFullBackfill,
  });
  log(`Collecting ${windows.length} window(s) for ${repo}`);

  const allRunsMap = new Map<number, Run>();
  for (const window of windows) {
    try {
      const windowRuns = await collectRunsForWindow(window);
      for (const run of windowRuns) {
        allRunsMap.set(run.id, run);
      }
    } catch (err) {
      if (err instanceof RateLimitAbortError) {
        for (const run of err.partialRuns) {
          allRunsMap.set(run.id, run);
        }
        persistCollectedRuns(storage, repo, index, Array.from(allRunsMap.values()), retentionDays, false);
      }
      throw err;
    }
  }

  const allRuns = Array.from(allRunsMap.values());
  log(`Total completed runs collected: ${allRuns.length}`);
  persistCollectedRuns(storage, repo, index, allRuns, retentionDays, true);
}

export async function runCollection({
  token,
  retentionDays,
  cliOptions,
  targetRepos,
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
  if (cliOptions.repoName) {
    console.log(`Single repo mode enabled; collecting only ${cliOptions.repoName}.`);
  }

  for (const repo of targetRepos) {
    try {
      await collectRepoImpl(client, repo, retentionDays, cliOptions);
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

  console.log('Done!');
}

export async function main() {
  const cliOptions = parseCollectCliOptions(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  const configuredRepos = readReposConfig();
  const targetRepos = resolveTargetRepos(configuredRepos, cliOptions.repoName);
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90');

  log(`VERBOSE mode: ${VERBOSE}`);
  log(`Retention days: ${retentionDays}`);
  log(`Force full backfill: ${cliOptions.forceFullBackfill}`);
  log(`Requested repo: ${cliOptions.repoName || '(all configured repos)'}`);
  log(`Target repos: ${targetRepos.join(', ') || '(none)'}`);
  log(`Node version: ${process.version}`);
  log(`ETL_DIR: ${ETL_DIR}`);
  log(`DATA_DIR: ${DATA_DIR}`);

  await runCollection({
    token,
    retentionDays,
    cliOptions,
    targetRepos,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    error(err);
    process.exit(1);
  });
}
