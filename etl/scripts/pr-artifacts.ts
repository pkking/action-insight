import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as prMetricsModule from '../../src/lib/pr-metrics';
import type { PullRequestRef, PullRequestSnapshot, Run } from '../../src/lib/types';
import { isGitHubRateLimitError, checkRateLimitBudget } from './github';

const prMetricsInterop =
  ('buildPullRequestIndex' in prMetricsModule && typeof prMetricsModule.buildPullRequestIndex === 'function')
    ? prMetricsModule
    : ((prMetricsModule as { default?: unknown; 'module.exports'?: unknown }).default ??
        (prMetricsModule as { default?: unknown; 'module.exports'?: unknown })['module.exports'] ??
        prMetricsModule);

const { buildPullRequestIndex } = prMetricsInterop as {
  buildPullRequestIndex: typeof import('../../src/lib/pr-metrics').buildPullRequestIndex;
};

interface StorageAdapter {
  readDayData: (repo: string, date: string) => { runs: Run[] };
}

interface OctokitLike {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

interface RebuildPullRequestArtifactsOptions {
  octokit?: OctokitLike;
  owner: string;
  repo: string;
  repoKey: string;
  repoDir: string;
  files: string[];
  storage: StorageAdapter;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

interface ShaMapFile {
  version: 1;
  generated_at: string;
  mappings: Record<string, number>;
}

const DEFAULT_SHA_RESOLUTION_LIMIT = 250;
const DEFAULT_RATE_LIMIT_RESERVE = 10;
const WORST_CASE_CALLS_PER_SHA_RESOLUTION = 3;

function getPrDir(repoDir: string): string {
  return path.join(repoDir, 'prs');
}

function getShaMapPath(repoDir: string): string {
  return path.join(getPrDir(repoDir), 'sha-map.json');
}

function readShaMap(repoDir: string): Map<string, number> {
  const shaMapPath = getShaMapPath(repoDir);
  if (!existsSync(shaMapPath)) {
    return new Map();
  }

  try {
    const data = JSON.parse(readFileSync(shaMapPath, 'utf8')) as Partial<ShaMapFile>;
    return new Map(
      Object.entries(data.mappings ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    );
  } catch {
    return new Map();
  }
}

function writeShaMap(repoDir: string, mappings: Map<string, number>): void {
  writeFileSync(
    getShaMapPath(repoDir),
    JSON.stringify(
      {
        version: 1,
        generated_at: new Date().toISOString(),
        mappings: Object.fromEntries([...mappings.entries()].sort(([left], [right]) => left.localeCompare(right))),
      } satisfies ShaMapFile,
      null,
      2
    )
  );
}

function getShaResolutionLimit(): number {
  const value = Number.parseInt(process.env.PR_ARTIFACT_SHA_RESOLUTION_LIMIT ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SHA_RESOLUTION_LIMIT;
}

function getRateLimitReserve(): number {
  const value = Number.parseInt(process.env.PR_ARTIFACT_RATE_LIMIT_RESERVE ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RATE_LIMIT_RESERVE;
}

function readRetainedRuns(repoKey: string, files: string[], storage: StorageAdapter): Run[] {
  const runs: Run[] = [];

  for (const file of files) {
    const day = file.replace(/\.json$/, '');
    const data = storage.readDayData(repoKey, day);
    runs.push(...data.runs);
  }

  return runs;
}

function isPullRequestLikeEvent(event?: string): boolean {
  return event === 'pull_request' || event === 'pull_request_target' || event === 'pull_request_review';
}

async function resolvePullRequestsFromHeadSha(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  shas: string[],
  warn: (...args: unknown[]) => void
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  let rateLimited = false;

  for (const sha of shas) {
    if (rateLimited) {
      warn(`Skipping PR resolution for commit ${sha}: rate limit reached`);
      continue;
    }
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
        owner,
        repo,
        commit_sha: sha,
      });
      const data = response.data as Array<{ number?: number }>;
      const number = data.find((pullRequest) => typeof pullRequest.number === 'number')?.number;
      if (typeof number === 'number') {
        resolved.set(sha, number);
        continue;
      }

      const searchResponse = await octokit.request('GET /search/issues', {
        q: `${sha} repo:${owner}/${repo} type:pr`,
        per_page: 1,
      });
      const searchData = searchResponse.data as { items?: Array<{ number?: number; pull_request?: unknown }> };
      const searchNumber = searchData.items?.find(
        (item) => item.pull_request && typeof item.number === 'number'
      )?.number;
      if (typeof searchNumber === 'number') {
        resolved.set(sha, searchNumber);
      }
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        rateLimited = true;
        warn(`Rate limit reached while resolving PRs for ${owner}/${repo}. ${resolved.size} PRs resolved so far.`);
        continue;
      }
      warn(`Failed to resolve PR for commit ${sha} in ${owner}/${repo}:`, error);
    }
  }

  return resolved;
}

async function fetchPullRequestSnapshots(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  numbers: number[],
  warn: (...args: unknown[]) => void
): Promise<Map<number, PullRequestSnapshot>> {
  const snapshots = new Map<number, PullRequestSnapshot>();
  let rateLimited = false;

  for (const number of numbers) {
    if (rateLimited) {
      warn(`Skipping PR #${number} fetch: rate limit reached`);
      continue;
    }
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: number,
      });
      const data = response.data as {
        number: number;
        title: string;
        state: string;
        created_at: string;
        merged_at: string | null;
        html_url: string;
        user?: { login: string };
      };

      snapshots.set(number, {
        number: data.number,
        title: data.title,
        state: data.state,
        created_at: data.created_at,
        merged_at: data.merged_at,
        html_url: data.html_url,
        user: data.user,
      });
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        rateLimited = true;
        warn(`Rate limit reached while fetching PR snapshots for ${owner}/${repo}. ${snapshots.size} snapshots fetched so far.`);
        continue;
      }
      warn(`Failed to fetch PR #${number} for ${owner}/${repo}:`, error);
    }
  }

  return snapshots;
}

export async function rebuildPullRequestArtifacts({
  octokit,
  owner,
  repo,
  repoKey,
  repoDir,
  files,
  storage,
  log = () => {},
  warn = () => {},
}: RebuildPullRequestArtifactsOptions): Promise<void> {
  const runs = readRetainedRuns(repoKey, files, storage);
  const prDir = getPrDir(repoDir);
  if (!existsSync(prDir)) {
    mkdirSync(prDir, { recursive: true });
  }

  const runsWithoutPr = runs.filter((run) => (!run.pull_requests || run.pull_requests.length === 0) && run.head_sha && isPullRequestLikeEvent(run.event));
  const uniqueShas = new Set(runsWithoutPr.map((run) => run.head_sha as string));
  const cachedPullRequestsBySha = readShaMap(repoDir);
  const unresolvedShas = [...uniqueShas].filter((sha) => !cachedPullRequestsBySha.has(sha));
  const allPrNumbers = Array.from(
    new Set(
      runs
        .map((run) => run.pull_requests?.[0]?.number)
        .filter((number): number is number => typeof number === 'number')
    )
  );
  const worstCaseExpectedCalls = (unresolvedShas.length * WORST_CASE_CALLS_PER_SHA_RESOLUTION) + allPrNumbers.length;
  let shaResolutionBudget = Math.min(unresolvedShas.length, getShaResolutionLimit());
  let skippedPrShaCount = Math.max(0, unresolvedShas.length - shaResolutionBudget);

  if (octokit && worstCaseExpectedCalls > 0) {
    const budget = await checkRateLimitBudget(octokit, worstCaseExpectedCalls);
    if (!budget.ok) {
      const rateLimitReserve = getRateLimitReserve();
      const availableForShaResolution = Math.floor(
        Math.max(0, budget.remaining - allPrNumbers.length - rateLimitReserve) / WORST_CASE_CALLS_PER_SHA_RESOLUTION
      );
      shaResolutionBudget = Math.min(shaResolutionBudget, availableForShaResolution);
      skippedPrShaCount = unresolvedShas.length - shaResolutionBudget;
      warn(
        `Rate limit budget check: ${budget.remaining} remaining, need up to ${worstCaseExpectedCalls}. Building partial PR artifacts with ${shaResolutionBudget} SHA lookup(s).`
      );
      if (budget.resetAt) {
        warn(`Rate limit resets at ${budget.resetAt.toISOString()}.`);
      }
    } else {
      log(`Rate limit budget check: ${budget.remaining} remaining, need up to ${worstCaseExpectedCalls}. Proceeding.`);
    }
  }

  const shasToResolve = unresolvedShas.slice(0, shaResolutionBudget);
  const newlyResolvedPullRequestsBySha = octokit
    ? await resolvePullRequestsFromHeadSha(octokit, owner, repo, shasToResolve, warn)
    : new Map<string, number>();
  for (const [sha, number] of newlyResolvedPullRequestsBySha.entries()) {
    cachedPullRequestsBySha.set(sha, number);
  }
  writeShaMap(repoDir, cachedPullRequestsBySha);

  const normalizedRuns = runs.map((run) => {
    if (run.pull_requests && run.pull_requests.length > 0) {
      return run;
    }

    const resolvedNumber = run.head_sha ? cachedPullRequestsBySha.get(run.head_sha) : undefined;
    if (typeof resolvedNumber !== 'number') {
      return run;
    }

    const pullRequests: PullRequestRef[] = [{ number: resolvedNumber }];
    return {
      ...run,
      pull_requests: pullRequests,
    };
  });
  const prNumbers = Array.from(
    new Set(
      normalizedRuns
        .map((run) => run.pull_requests?.[0]?.number)
        .filter((number): number is number => typeof number === 'number')
    )
  ).sort((left, right) => right - left);

  const resolvedRelevantShaCount = [...uniqueShas].filter((sha) => cachedPullRequestsBySha.has(sha)).length;
  const partialPrResolution = skippedPrShaCount > 0 || newlyResolvedPullRequestsBySha.size < shasToResolve.length;

  if (prNumbers.length === 0) {
    writeFileSync(
      path.join(prDir, 'index.json'),
      JSON.stringify(
        {
          repo: repoKey,
          generated_at: new Date().toISOString(),
          prs: [],
          partialPrResolution,
          resolvedPrShaCount: resolvedRelevantShaCount,
          unresolvedPrShaCount: uniqueShas.size - resolvedRelevantShaCount,
          skippedPrShaCount,
        },
        null,
        2
      )
    );

    for (const entry of readdirSync(prDir)) {
      if (entry !== 'index.json' && entry !== 'sha-map.json') {
        rmSync(path.join(prDir, entry), { force: true });
      }
    }

    return;
  }

  log(`Building PR artifacts for ${repoKey}: ${prNumbers.length} PRs`);
  const pullRequests = octokit
    ? await fetchPullRequestSnapshots(octokit, owner, repo, prNumbers, warn)
    : new Map<number, PullRequestSnapshot>();
  const retentionStartDate = files.map((file) => file.replace(/\.json$/, '')).sort()[0];
  const result = buildPullRequestIndex({
    repo: repoKey,
    runs: normalizedRuns,
    pullRequests,
    retentionStartDate,
  });
  result.index.partialPrResolution = partialPrResolution;
  result.index.resolvedPrShaCount = resolvedRelevantShaCount;
  result.index.unresolvedPrShaCount = uniqueShas.size - resolvedRelevantShaCount;
  result.index.skippedPrShaCount = skippedPrShaCount;

  writeFileSync(path.join(prDir, 'index.json'), JSON.stringify(result.index, null, 2));

  const staleEntries = new Set(readdirSync(prDir).filter((entry) => entry !== 'index.json' && entry !== 'sha-map.json'));
  for (const [number, detail] of result.details.entries()) {
    const fileName = `${number}.json`;
    staleEntries.delete(fileName);
    writeFileSync(path.join(prDir, fileName), JSON.stringify(detail, null, 2));
  }

  for (const entry of staleEntries) {
    rmSync(path.join(prDir, entry), { force: true });
  }
}
