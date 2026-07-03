import * as prMetricsModule from '../../src/lib/pr-metrics';
import type { PullRequestRef, PullRequestSnapshot, Run } from '../../src/lib/types';
import { isGitHubRateLimitError, checkRateLimitBudget } from './github';
import {
  readPullRequestResolutionCacheFromTurso,
  type PullRequestResolutionCacheEntry,
  writePrMetricsToTurso,
  writePrWorkflowsToTurso,
  writePullRequestResolutionCacheToTurso,
} from './turso-storage';
import {
  readPullRequestResolutionCacheFromSqlite,
  writePrMetricsToSqlite,
  writePrWorkflowsToSqlite,
  writePullRequestResolutionCacheToSqlite,
} from './sqlite-storage';

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

const DEFAULT_SHA_RESOLUTION_LIMIT = 1000;
const DEFAULT_SEARCH_RESOLUTION_LIMIT = 20;
const DEFAULT_RATE_LIMIT_RESERVE = 10;
const RUN_PAYLOAD_PR_SOURCE = 'run_payload';

function isSqliteFallbackEnabled(): boolean {
  return process.env.ENABLE_SQLITE_FALLBACK === '1' || process.env.ENABLE_SQLITE_FALLBACK === 'true';
}

async function writeWithOptionalSqliteFallback(
  primary: () => Promise<void>,
  fallback: () => Promise<void>,
  label: string,
  warn: (...args: unknown[]) => void
): Promise<void> {
  try {
    await primary();
  } catch (err) {
    if (!isSqliteFallbackEnabled()) throw err;
    warn(`${label} Turso write failed, using SQLite fallback:`, err);
    await fallback();
    return;
  }

  if (isSqliteFallbackEnabled()) {
    await fallback();
  }
}

interface ShaResolutionResult {
  entries: PullRequestResolutionCacheEntry[];
  coreApiCalls: number;
  searchApiCalls: number;
}

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
): Promise<ShaResolutionResult> {
  const entries: PullRequestResolutionCacheEntry[] = [];
  let searchRateLimited = false;
  let coreRateLimited = false;
  let searchAttempts = 0;
  let coreApiCalls = 0;
  let searchApiCalls = 0;
  const searchResolutionLimit = getSearchResolutionLimit();

  for (const sha of shas) {
    if (coreRateLimited) {
      warn(`Skipping PR resolution for commit ${sha}: core rate limit reached`);
      entries.push({
        head_sha: sha,
        status: 'rate_limited',
        source: 'commits_api',
        error_message: 'Core API rate limit reached before this SHA was resolved',
      });
      continue;
    }

    let failed = false;
    let rateLimited = false;
    try {
      coreApiCalls += 1;
      const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
        owner,
        repo,
        commit_sha: sha,
      });
      const data = response.data as Array<{ number?: number }>;
      const number = data.find((pullRequest) => typeof pullRequest.number === 'number')?.number;
      if (typeof number === 'number') {
        entries.push({
          head_sha: sha,
          pr_number: number,
          source: 'commits_api',
          status: 'resolved',
        });
        continue;
      }
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        coreRateLimited = true;
        rateLimited = true;
        warn(`Core API rate limit reached while resolving PRs for ${owner}/${repo}.`);
      } else {
        failed = true;
        warn(`Failed to resolve PR for commit ${sha} in ${owner}/${repo}:`, error);
      }
    }

    const searchBudgetExhausted = searchAttempts >= searchResolutionLimit;
    if (!rateLimited && !searchRateLimited && !searchBudgetExhausted) {
      try {
        searchAttempts += 1;
        searchApiCalls += 1;
        const searchResponse = await octokit.request('GET /search/issues', {
          q: `${sha} repo:${owner}/${repo} type:pr`,
          per_page: 1,
        });

        const searchData = searchResponse.data as { items?: Array<{ number?: number; pull_request?: unknown }> };
        const searchNumber = searchData.items?.find(
          (item) => item.pull_request && typeof item.number === 'number'
        )?.number;

        if (typeof searchNumber === 'number') {
          entries.push({
            head_sha: sha,
            pr_number: searchNumber,
            source: 'search_api',
            status: 'resolved',
          });
          continue;
        }
      } catch (error) {
        if (isGitHubRateLimitError(error)) {
          searchRateLimited = true;
          rateLimited = true;
          warn(`Search API rate limit reached for ${owner}/${repo}. Disabling search fallback for remaining commits.`);
        } else {
          failed = true;
          warn(`Search API failed for commit ${sha} in ${owner}/${repo}:`, error);
        }
      }
    }

    if (!rateLimited && !searchRateLimited && searchBudgetExhausted) {
      failed = true;
      warn(`Search API fallback budget exhausted for ${owner}/${repo}; commit ${sha} will be retried later.`);
    }

    if (rateLimited) {
      entries.push({
        head_sha: sha,
        status: 'rate_limited',
        source: 'commits_api',
        error_message: 'GitHub API rate limit reached during SHA to PR resolution',
      });
      continue;
    }

    if (failed) {
      entries.push({
        head_sha: sha,
        status: 'failed',
        source: 'commits_api',
        error_message: searchBudgetExhausted
          ? 'Search API fallback budget exhausted before this SHA was fully resolved'
          : 'GitHub API lookup failed during SHA to PR resolution',
      });
      continue;
    }

    entries.push({
      head_sha: sha,
      status: 'not_found',
      source: 'commits_api',
    });
  }

  return { entries, coreApiCalls, searchApiCalls };
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
  // Resolve SHAs for runs that lack PR associations.
  // 仅针对 PR 相关事件和 push 事件（用于合并提交）进行 SHA→PR 解析，
  // 排除其他事件（如 schedule、workflow_dispatch）以避免浪费 GitHub API 速率限制预算。
  const runsWithoutPr = runs.filter((run) => (!run.pull_requests || run.pull_requests.length === 0) && run.head_sha && (isPullRequestLikeEvent(run.event) || run.event === 'push'));

  // Prioritize pull_request events over push events for SHA resolution.
  // Pull_request SHAs have a much higher resolution rate via the commits API,
  // so resolving them first maximizes useful PR associations within the budget.
  const eventPriority: Record<string, number> = { pull_request: 0, pull_request_target: 0, pull_request_review: 0, push: 1 };
  const sortedWithoutPr = [...runsWithoutPr].sort((a, b) => (eventPriority[a.event ?? ''] ?? 1) - (eventPriority[b.event ?? ''] ?? 1));

  const uniqueShas = new Set(sortedWithoutPr.map((run) => run.head_sha as string));
  const cachedPullRequestsBySha = new Map<string, number>();
  const notFoundShas = new Set<string>();
  const cacheEntriesToWrite: PullRequestResolutionCacheEntry[] = [];

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

  const persistedCache = await readPullRequestResolutionCacheFromTurso(repoKey, [...uniqueShas]);
  if (isSqliteFallbackEnabled()) {
    const persistedCacheSqlite = await readPullRequestResolutionCacheFromSqlite(repoKey, [...uniqueShas]).catch(() => new Map());
    for (const [sha, record] of persistedCacheSqlite.entries()) {
      if (!persistedCache.has(sha)) {
        persistedCache.set(sha, record);
      }
    }
  }
  let resolvedCacheHitCount = 0;
  let notFoundCacheHitCount = 0;
  let retryableCacheHitCount = 0;
  for (const [sha, cached] of persistedCache.entries()) {
    if (cached.status === 'resolved' && typeof cached.pr_number === 'number') {
      cachedPullRequestsBySha.set(sha, cached.pr_number);
      resolvedCacheHitCount += 1;
    } else if (cached.status === 'not_found') {
      notFoundShas.add(sha);
      notFoundCacheHitCount += 1;
    } else {
      retryableCacheHitCount += 1;
    }
  }

  const unresolvedShas = [...uniqueShas].filter((sha) => !cachedPullRequestsBySha.has(sha) && !notFoundShas.has(sha));
  log(
    `PR resolution cache for ${repoKey}: ${resolvedCacheHitCount} resolved hit(s), ${notFoundCacheHitCount} not-PR hit(s), ${retryableCacheHitCount} retryable hit(s), ${unresolvedShas.length} miss(es)`
  );

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
  const resolutionResult = octokit && shasToResolve.length > 0
    ? await resolvePullRequestsFromHeadSha(octokit, owner, repo, shasToResolve, warn)
    : { entries: [], coreApiCalls: 0, searchApiCalls: 0 };
  let newlyResolvedShaCount = 0;
  let newlyNotFoundShaCount = 0;
  let newlyFailedShaCount = 0;
  let newlyRateLimitedShaCount = 0;
  for (const entry of resolutionResult.entries) {
    if (entry.status === 'resolved' && typeof entry.pr_number === 'number') {
      cachedPullRequestsBySha.set(entry.head_sha, entry.pr_number);
      newlyResolvedShaCount += 1;
    } else if (entry.status === 'not_found') {
      notFoundShas.add(entry.head_sha);
      newlyNotFoundShaCount += 1;
    } else if (entry.status === 'rate_limited') {
      newlyRateLimitedShaCount += 1;
    } else {
      newlyFailedShaCount += 1;
    }

    cacheEntriesToWrite.push(entry);
  }
  await writeWithOptionalSqliteFallback(
    () => writePullRequestResolutionCacheToTurso(repoKey, cacheEntriesToWrite),
    () => writePullRequestResolutionCacheToSqlite(repoKey, cacheEntriesToWrite),
    'writePullRequestResolutionCache',
    warn,
  );
  log(
    `PR resolution API calls for ${repoKey}: ${resolutionResult.coreApiCalls} core, ${resolutionResult.searchApiCalls} search; resolved ${newlyResolvedShaCount}, not_found ${newlyNotFoundShaCount}, failed ${newlyFailedShaCount}, rate_limited ${newlyRateLimitedShaCount}, skipped ${skippedPrShaCount}`
  );

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
  const unresolvedRelevantShaCount = uniqueShas.size - resolvedRelevantShaCount - notFoundShas.size;
  const partialPrResolution = unresolvedRelevantShaCount > 0;

  if (prNumbers.length === 0) {
    await writeWithOptionalSqliteFallback(
      () => writePrMetricsToTurso(repoKey, []),
      () => writePrMetricsToSqlite(repoKey, []),
      'writePrMetrics-empty',
      warn,
    );
    log(`PR metrics written for ${repoKey}: 0 rows; latest created_at: none`);
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
  result.index.unresolvedPrShaCount = unresolvedRelevantShaCount;
  result.index.skippedPrShaCount = skippedPrShaCount;

  await writeWithOptionalSqliteFallback(
    () => writePrMetricsToTurso(repoKey, result.index.prs),
    () => writePrMetricsToSqlite(repoKey, result.index.prs),
    'writePrMetrics',
    warn,
  );
  log(`PR metrics written for ${repoKey}: ${result.index.prs.length} rows; latest created_at: ${result.index.prs[0]?.created_at ?? 'none'}`);

  const prWorkflowsMap = new Map<number, number[]>();
  for (const [prNumber, detail] of result.details.entries()) {
    prWorkflowsMap.set(prNumber, detail.pr.workflows.map((w) => w.id));
  }
  await writeWithOptionalSqliteFallback(
    () => writePrWorkflowsToTurso(repoKey, prWorkflowsMap),
    () => writePrWorkflowsToSqlite(repoKey, prWorkflowsMap),
    'writePrWorkflows',
    warn,
  );
  log(`PR workflows written for ${repoKey}: ${prWorkflowsMap.size} PRs`);
}
