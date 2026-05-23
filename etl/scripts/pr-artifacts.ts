import * as prMetricsModule from '../../src/lib/pr-metrics';
import type { PullRequestRef, PullRequestSnapshot, Run } from '../../src/lib/types';
import { isGitHubRateLimitError, checkRateLimitBudget } from './github';
import {
  readPullRequestResolutionCacheFromSupabase,
  writePrMetricsToSupabase,
  writePrWorkflowsToSupabase,
  writePullRequestResolutionCacheToSupabase,
} from './supabase-storage';

const prMetricsInterop =
  ('buildPullRequestIndex' in prMetricsModule && typeof prMetricsModule.buildPullRequestIndex === 'function')
    ? prMetricsModule
    : ((prMetricsModule as { default?: unknown; 'module.exports'?: unknown }).default ??
        (prMetricsModule as { default?: unknown; 'module.exports'?: unknown })['module.exports'] ??
        prMetricsModule);

const { buildPullRequestIndex } = prMetricsInterop as {
  buildPullRequestIndex: typeof import('../../src/lib/pr-metrics').buildPullRequestIndex;
};

interface OctokitLike {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

interface RebuildPullRequestArtifactsOptions {
  octokit?: OctokitLike;
  owner: string;
  repo: string;
  repoKey: string;
  collectedDates: string[];
  runs: Run[];
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

const DEFAULT_SHA_RESOLUTION_LIMIT = 250;
const DEFAULT_SEARCH_RESOLUTION_LIMIT = 5;
const DEFAULT_RATE_LIMIT_RESERVE = 10;
const RUN_PAYLOAD_PR_SOURCE = 'run_payload';

function getShaResolutionLimit(): number {
  const value = Number.parseInt(process.env.PR_ARTIFACT_SHA_RESOLUTION_LIMIT ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SHA_RESOLUTION_LIMIT;
}

function getRateLimitReserve(): number {
  const value = Number.parseInt(process.env.PR_ARTIFACT_RATE_LIMIT_RESERVE ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RATE_LIMIT_RESERVE;
}

function getSearchResolutionLimit(): number {
  const value = Number.parseInt(process.env.PR_ARTIFACT_SEARCH_RESOLUTION_LIMIT ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SEARCH_RESOLUTION_LIMIT;
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
): Promise<Map<string, { number: number; source: string }>> {
  const resolved = new Map<string, { number: number; source: string }>();
  let searchRateLimited = false;
  let coreRateLimited = false;
  let searchAttempts = 0;
  const searchResolutionLimit = getSearchResolutionLimit();

  for (const sha of shas) {
    if (coreRateLimited) {
      warn(`Skipping PR resolution for commit ${sha}: core rate limit reached`);
      break;
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
        resolved.set(sha, { number, source: 'commits_api' });
        continue;
      }
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        coreRateLimited = true;
        warn(`Core API rate limit reached while resolving PRs for ${owner}/${repo}. ${resolved.size} PRs resolved so far.`);
        continue;
      }
      warn(`Failed to resolve PR for commit ${sha} in ${owner}/${repo}:`, error);
    }

    if (!searchRateLimited && searchAttempts < searchResolutionLimit) {
      try {
        searchAttempts += 1;
        const searchResponse = await octokit.request('GET /search/issues', {
          q: `${sha} repo:${owner}/${repo} type:pr`,
          per_page: 1,
        });

        const searchData = searchResponse.data as { items?: Array<{ number?: number; pull_request?: unknown }> };
        const searchNumber = searchData.items?.find(
          (item) => item.pull_request && typeof item.number === 'number'
        )?.number;

        if (typeof searchNumber === 'number') {
          resolved.set(sha, { number: searchNumber, source: 'search_api' });
          continue;
        }
      } catch (error) {
        if (isGitHubRateLimitError(error)) {
          searchRateLimited = true;
          warn(`Search API rate limit reached for ${owner}/${repo}. Disabling search fallback for remaining commits. ${resolved.size} PRs resolved so far.`);
        } else {
          warn(`Search API failed for commit ${sha} in ${owner}/${repo}:`, error);
        }
      }
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
  collectedDates,
  runs,
  log = () => {},
  warn = () => {},
}: RebuildPullRequestArtifactsOptions): Promise<void> {
  const runsWithoutPr = runs.filter((run) => (!run.pull_requests || run.pull_requests.length === 0) && run.head_sha && isPullRequestLikeEvent(run.event));
  const uniqueShas = new Set(runsWithoutPr.map((run) => run.head_sha as string));
  const cachedPullRequestsBySha = new Map<string, number>();
  const cacheEntriesToWrite: Array<{ head_sha: string; pr_number: number; source: string }> = [];

  for (const run of runs) {
    const prNumber = run.pull_requests?.[0]?.number;
    if (run.head_sha && typeof prNumber === 'number' && isPullRequestLikeEvent(run.event)) {
      cachedPullRequestsBySha.set(run.head_sha, prNumber);
      cacheEntriesToWrite.push({
        head_sha: run.head_sha,
        pr_number: prNumber,
        source: RUN_PAYLOAD_PR_SOURCE,
      });
    }
  }

  const persistedCache = await readPullRequestResolutionCacheFromSupabase(repoKey, [...uniqueShas]);
  for (const [sha, number] of persistedCache.entries()) {
    cachedPullRequestsBySha.set(sha, number);
  }

  const unresolvedShas = [...uniqueShas].filter((sha) => !cachedPullRequestsBySha.has(sha));
  const allPrNumbers = Array.from(
    new Set(
      [
        ...runs
          .map((run) => run.pull_requests?.[0]?.number)
          .filter((number): number is number => typeof number === 'number'),
        ...cachedPullRequestsBySha.values(),
      ]
    )
  );
  let shaResolutionBudget = Math.min(unresolvedShas.length, getShaResolutionLimit());
  const expectedCoreCalls = shaResolutionBudget + allPrNumbers.length;
  let skippedPrShaCount = Math.max(0, unresolvedShas.length - shaResolutionBudget);

  if (octokit && expectedCoreCalls > 0) {
    const budget = await checkRateLimitBudget(octokit, expectedCoreCalls);
    if (!budget.ok) {
      const rateLimitReserve = getRateLimitReserve();
      const availableForShaResolution = Math.max(
        0,
        budget.remaining - allPrNumbers.length - rateLimitReserve
      );
      shaResolutionBudget = Math.min(shaResolutionBudget, availableForShaResolution);
      skippedPrShaCount = unresolvedShas.length - shaResolutionBudget;
      warn(
        `Core rate limit budget check: ${budget.remaining} remaining, need ${expectedCoreCalls}. Building partial PR artifacts with ${shaResolutionBudget} SHA lookup(s).`
      );
      if (budget.resetAt) {
        warn(`Rate limit resets at ${budget.resetAt.toISOString()}.`);
      }
    } else {
      log(`Core rate limit budget check: ${budget.remaining} remaining, need ${expectedCoreCalls}. Proceeding.`);
    }
  }

  const shasToResolve = unresolvedShas.slice(0, shaResolutionBudget);
  const newlyResolvedPullRequestsBySha = octokit
    ? await resolvePullRequestsFromHeadSha(octokit, owner, repo, shasToResolve, warn)
    : new Map<string, { number: number; source: string }>();
  for (const [sha, resolution] of newlyResolvedPullRequestsBySha.entries()) {
    cachedPullRequestsBySha.set(sha, resolution.number);
    cacheEntriesToWrite.push({
      head_sha: sha,
      pr_number: resolution.number,
      source: resolution.source,
    });
  }
  await writePullRequestResolutionCacheToSupabase(repoKey, cacheEntriesToWrite);

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
    await writePrMetricsToSupabase(repoKey, []);
    return;
  }

  log(`Building PR artifacts for ${repoKey}: ${prNumbers.length} PRs`);
  const pullRequests = octokit
    ? await fetchPullRequestSnapshots(octokit, owner, repo, prNumbers, warn)
    : new Map<number, PullRequestSnapshot>();
  const retentionStartDate = collectedDates.sort()[0];
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

  await writePrMetricsToSupabase(repoKey, result.index.prs);

  const prWorkflowsMap = new Map<number, number[]>();
  for (const [prNumber, detail] of result.details.entries()) {
    prWorkflowsMap.set(prNumber, detail.pr.workflows.map((w) => w.id));
  }
  await writePrWorkflowsToSupabase(repoKey, prWorkflowsMap);
}
