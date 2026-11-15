// ETL script: collect cancel-actor evidence for cancelled workflow attempts (ADR-040).
//
// GitHub's run object has no "cancelled by" field; the only machine-readable
// source is the check-run annotation "The run was canceled by @login." that
// GitHub attaches to explicitly cancelled jobs (system cancels get none).
// This script probes annotations for pending cancelled workflow attempts and
// persists the evidence to workflow_attempts:
//
//   cancelled_by NULL + cancel_annotation_fetched_at NULL -> not probed yet
//   cancelled_by NULL + fetched_at set                    -> probed, no explicit canceller
//   cancelled_by set + fetched_at set                     -> explicit cancel (human/bot)
//
// Every attempt is checkpointed with a single UPDATE immediately after probing
// (`cancel_annotation_fetched_at IS NULL` guards both the resume query and the
// write), so re-runs after rate-limit aborts make zero duplicate API calls.
// Reuses the collect.ts retry/rate-limit/token conventions instead of copying:
// withRetry, RateLimitAbortError, reserveRateLimitBudget (shared-identity
// budget lanes), isGitHubRateLimitError/getRateLimitDetails, resolveGitHubTokens.
import type { Octokit } from '@octokit/core';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  RateLimitAbortError,
  reserveRateLimitBudget,
  resetSharedRetryCount,
  getSharedRetryCount,
  withRetry,
} from './collect.ts';
import {
  createOctokit,
  getGitHubIdentity,
  getRateLimitDetails,
  isGitHubRateLimitError,
  resolveGitHubTokens,
  type GitHubRequestErrorLike,
} from './github.ts';
import { getDatabaseClient, type DbClient } from '../../src/lib/db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERBOSE = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
const PER_PAGE = 100;
/** Annotations pagination: one page, then up to 2 more only when full (ADR-040). */
const ANNOTATION_MAX_PAGES = 3;
/** Fallback check-run listing pagination: max 3 pages (ADR-040). */
const CHECK_RUNS_MAX_PAGES = 3;
/** Probe at most this many cancelled jobs per attempt, runtime DESC (ADR-040). */
const MAX_PROBED_CANCELLED_JOBS = 2;
/** Probe at most this many cancelled check runs on the head-sha fallback path. */
const MAX_FALLBACK_CHECK_RUNS = 2;
const DEFAULT_LIMIT = 500;

/** collect.ts keeps its RATE_LIMIT_RESERVE private; reserve enforcement already
 * lives inside reserveRateLimitBudget, so this copy is display-only. */
const RATE_LIMIT_RESERVE = Number.parseInt(process.env.GITHUB_RATE_LIMIT_RESERVE ?? '10', 10);

function resolveConcurrency(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(4, Math.max(1, parsed));
}
const CANCEL_FETCH_CONCURRENCY = resolveConcurrency(process.env.CANCEL_FETCH_CONCURRENCY);

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

type CancelEvidence = 'job_annotation' | 'check_run_annotation' | 'none' | 'gone' | 'no_cancelled_check_run';
const CANCEL_EVIDENCES: CancelEvidence[] = ['job_annotation', 'check_run_annotation', 'none', 'gone', 'no_cancelled_check_run'];

interface CliOptions {
  repos: string[];
  attemptsFile?: string;
  limit: number;
  minHours: number;
  maxApiCalls?: number;
  dryRun: boolean;
  help: boolean;
}

export const CLI_HELP = `Usage: npx tsx etl/scripts/collect-cancel-annotations.ts [options]

Collect cancel-actor evidence for cancelled workflow attempts via
check-run annotations and persist it to workflow_attempts.

Options:
  --repo, -r <owner/repo>     Only process this repo (repeatable).
                              Default: all repos referenced by --attempts-file,
                              or all repos with pending cancelled attempts.
  --attempts-file <path>      JSON artifact from npu_waste_superseded.py
                              (key 'cancelled_unknown_attempts': [{repo,
                              run_id, run_attempt}, ...]). Membership-only;
                              ordering/filtering/idempotency stay in SQL.
                              Omit to scan the full allowlist corpus of
                              cancelled attempts (bounded by DB retention).
  --limit <n>                 Max attempts to process this run (default 500)
  --min-hours <h>             Only attempts with runtime_seconds >= h*3600
                              (default 0)
  --max-api-calls <n>         Hard stop after n GitHub API calls (safety cap)
  --dry-run                   Print per-repo target counts and estimated API
                              calls; no API requests, no DB writes
  -h, --help                  Show this help

Environment:
  PG_DATABASE_URL             PostgreSQL URL (default local Docker 5433)
  GITHUB_TOKEN                / gh-token.txt / gh auth (via resolveGitHubTokens)
  GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>   Per-repo CI secret, highest priority
  GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND  Fallback PAT
  GITHUB_RATE_LIMIT_RESERVE  Budget reserve (default 10, collect.ts semantics)
  CANCEL_FETCH_CONCURRENCY    Per-identity concurrent probes, clamp 1..4 (default 2)
  VERBOSE                     Verbose logging (true/1)`.trim();

export function parseCliOptions(argv: string[]): CliOptions {
  const repos: string[] = [];
  let attemptsFile: string | undefined;
  let limit = DEFAULT_LIMIT;
  let minHours = 0;
  let maxApiCalls: number | undefined;
  let dryRun = false;
  let help = false;

  const positiveInt = (value: string, optionName: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${optionName} requires a positive integer, got: ${value}`);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--repo' || arg === '-r') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires an owner/repo value`);
      }
      if (!next.includes('/')) {
        throw new Error(`${arg} expects owner/repo format, got: ${next}`);
      }
      if (!repos.includes(next)) repos.push(next);
      index += 1;
      continue;
    }

    if (arg === '--attempts-file') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a file path`);
      }
      attemptsFile = next;
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a positive integer`);
      }
      limit = positiveInt(next, arg);
      index += 1;
      continue;
    }

    if (arg === '--min-hours') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a non-negative number`);
      }
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${arg} requires a non-negative number, got: ${next}`);
      }
      minHours = parsed;
      index += 1;
      continue;
    }

    if (arg === '--max-api-calls') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a positive integer`);
      }
      maxApiCalls = positiveInt(next, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { repos, attemptsFile, limit, minHours, maxApiCalls, dryRun, help };
}

/** ADR-040 three-layer token resolution (AGENTS.md priority):
 * per-repo CI secret -> shared fallback PAT -> resolveGitHubTokens() rotation.
 * collect.ts keeps its RATE_LIMIT_RESERVE private; the reserve itself is
 * enforced inside reserveRateLimitBudget, so only the lookup lives here. */
export function resolveTokenForRepo(repoKey: string, tokens: string[], index: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const perRepoKey = `GITHUB_TOKEN_PER_REPO_${repoKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return env[perRepoKey]
    ?? env.GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND
    ?? (tokens.length > 0 ? tokens[index % tokens.length] : undefined);
}

/** Extract the cancelling login from a check-run annotation message.
 * Matches both "canceled" and "cancelled" spellings and keeps [bot] suffixes
 * (e.g. github-actions[bot]) intact — the ADR regex sketch dropped the bracket
 * suffix, which would have lost the bot evidence the sampling found. */
export function extractCanceller(message: string): string | null {
  const match = /run was cancell?ed by @([A-Za-z0-9-]+(?:\[[A-Za-z0-9-]+\])?)\./i.exec(message);
  return match ? match[1] : null;
}

/** Load the cancelled-unknown member list exported by npu_waste_superseded.py.
 * Membership-only: ordering, filtering and idempotency stay in SQL. */
export function loadAttemptsFileTargets(filePath: string, readFile: typeof fs.readFileSync = fs.readFileSync): Map<string, Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read attempts file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = (parsed as { cancelled_unknown_attempts?: unknown } | null)?.cancelled_unknown_attempts;
  if (!Array.isArray(list)) {
    throw new Error(`Attempts file ${filePath} does not contain a 'cancelled_unknown_attempts' array`);
  }
  const targets = new Map<string, Set<string>>();
  for (const entry of list) {
    const rec = entry as { repo?: unknown; run_id?: unknown; run_attempt?: unknown };
    if (typeof rec.repo !== 'string' || typeof rec.run_id !== 'number' || typeof rec.run_attempt !== 'number') {
      warn(`Skipping malformed attempts-file entry: ${JSON.stringify(rec)}`);
      continue;
    }
    if (!targets.has(rec.repo)) targets.set(rec.repo, new Set());
    targets.get(rec.repo)!.add(`${rec.run_id}:${rec.run_attempt}`);
  }
  return targets;
}

interface AttemptTarget {
  repo: string;
  repoId: number;
  runId: number;
  runAttempt: number;
  runtimeSeconds: number | null;
  headSha: string | null;
}

interface ProbeOutcome {
  cancelledBy: string | null;
  evidence: CancelEvidence;
  message: string | null;
}

/** Shared per-run API budget state; --max-api-calls is the hard cap. */
interface CountedApiState {
  calls: number;
  max?: number;
}

type RequestFn = (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown; status?: number; headers?: Record<string, unknown> }>;

interface BudgetClient {
  request: RequestFn;
  getBudget: () => number;
  refreshBudget: () => Promise<number>;
}

interface Lane {
  identity: string;
  budgetClient: BudgetClient;
  request: RequestFn;
  queue: AttemptTarget[];
}

class MaxApiCallsReachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaxApiCallsReachedError';
  }
}

/** Shape anomalies must retry like collect.ts's InvalidGitHubResponseError, but
 * that class is not exported; carry a synthetic 5xx status so collect.ts's
 * isTransientError (exported and used by withRetry) classifies them transient. */
class InvalidAnnotationsResponseError extends Error {
  status = 502;
}

function makeCountedRequest(request: RequestFn, state: CountedApiState): RequestFn {
  return async (route, params) => {
    if (state.max !== undefined && state.calls >= state.max) {
      throw new MaxApiCallsReachedError(`--max-api-calls budget exhausted (${state.calls}/${state.max} API calls used)`);
    }
    state.calls += 1;
    return request(route, params);
  };
}

function toRateLimitAbortError(err: unknown): RateLimitAbortError {
  const details = getRateLimitDetails(err as GitHubRequestErrorLike);
  return new RateLimitAbortError(
    `GitHub API rate limit reached (remaining=${details.remaining || 'unknown'}, limit=${details.limit || 'unknown'}, reset=${details.reset || 'unknown'})`,
    [],
    details,
  );
}

function splitRepo(repo: string): [string, string] {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  return [owner, repoName];
}

async function buildLane(token: string, state: CountedApiState): Promise<Lane> {
  const client = createOctokit(token);
  const setupRequest = makeCountedRequest(client.request.bind(client) as unknown as RequestFn, state);
  const identity = await getGitHubIdentity({ request: setupRequest } as unknown as Octokit);
  const rateLimitResponse = await setupRequest('GET /rate_limit');
  const data = rateLimitResponse.data as { resources?: { core?: { remaining?: number; reset?: number } } };
  const budgetClient = reserveRateLimitBudget(
    client,
    data.resources?.core?.remaining ?? 0,
    data.resources?.core?.reset,
  ) as unknown as BudgetClient;
  return { identity, budgetClient, request: makeCountedRequest(budgetClient.request, state), queue: [] };
}

async function lookupRepoId(client: DbClient, repo: string): Promise<number | null> {
  const [owner, repoName] = splitRepo(repo);
  const { rows } = await withRetry(
    () => client.query('SELECT id FROM repos WHERE owner = $1 AND repo = $2', [owner, repoName]),
    3, 2000, undefined, `SELECT repo id for ${repo}`,
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

const TARGET_WHERE = `WHERE r.repo_id = $1
  AND r.event = 'pull_request'
  AND a.conclusion = 'cancelled'
  AND a.cancel_annotation_fetched_at IS NULL
  AND a.runtime_seconds >= $2 * 3600`;

const TEMP_TABLE_JOIN = 'JOIN cancel_targets ct ON ct.run_id = a.run_id AND ct.run_attempt = a.run_attempt';

/** Pending cancelled attempts per repo, biggest runtime first (ADR-040). */
export function buildTargetQuery(useAttemptsFile: boolean): string {
  return `SELECT a.run_id, a.run_attempt, a.runtime_seconds, r.head_sha
FROM workflow_attempts a
JOIN runs r ON r.id = a.run_id
${useAttemptsFile ? `${TEMP_TABLE_JOIN}\n` : ''}${TARGET_WHERE}
ORDER BY a.runtime_seconds DESC
LIMIT $3`;
}

/** Dry-run estimate: annotation calls bounded by 2 probed jobs per attempt plus
 * 3 calls (1 listing + up to 2 annotations) per fallback attempt. */
export function buildDryRunStatsQuery(useAttemptsFile: boolean): string {
  return `SELECT COALESCE(SUM(LEAST(q.cnt, 2)), 0) AS main_annotation_calls,
       COUNT(*) FILTER (WHERE q.cnt = 0) AS fallback_attempts,
       COUNT(*) AS attempts
FROM (
  SELECT (SELECT COUNT(*) FROM workflow_jobs j
          WHERE j.run_id = a.run_id AND j.run_attempt = a.run_attempt
            AND j.conclusion = 'cancelled') AS cnt
  FROM workflow_attempts a
  JOIN runs r ON r.id = a.run_id
  ${useAttemptsFile ? `${TEMP_TABLE_JOIN}\n  ` : ''}${TARGET_WHERE}
  ORDER BY a.runtime_seconds DESC
  LIMIT $3
) q`;
}

const PENDING_REPOS_QUERY = `SELECT ro.id AS repo_id, ro.owner || '/' || ro.repo AS repo, COUNT(*) AS pending
FROM workflow_attempts a
JOIN runs r ON r.id = a.run_id
JOIN repos ro ON ro.id = r.repo_id
WHERE r.event = 'pull_request'
  AND a.conclusion = 'cancelled'
  AND a.cancel_annotation_fetched_at IS NULL
  AND a.runtime_seconds >= $1 * 3600
GROUP BY ro.id, ro.owner, ro.repo
ORDER BY pending DESC`;

async function loadAttemptsIntoTempTable(client: DbClient, fileTargets: Map<string, Set<string>>): Promise<number> {
  await withRetry(() => client.query('CREATE TEMP TABLE cancel_targets (run_id BIGINT, run_attempt INTEGER)'), 3, 2000, undefined, 'CREATE TEMP TABLE cancel_targets');
  const pairs: Array<[number, number]> = [];
  for (const keys of fileTargets.values()) {
    for (const key of keys) {
      const [runId, runAttempt] = key.split(':');
      pairs.push([Number(runId), Number(runAttempt)]);
    }
  }
  const chunkSize = 500;
  for (let offset = 0; offset < pairs.length; offset += chunkSize) {
    const chunk = pairs.slice(offset, offset + chunkSize);
    const values = chunk.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ');
    await withRetry(
      () => client.query(`INSERT INTO cancel_targets (run_id, run_attempt) VALUES ${values}`, chunk.flat()),
      3, 2000, undefined, `INSERT cancel_targets batch ${offset / chunkSize + 1}`,
    );
  }
  log(`Loaded ${pairs.length} cancelled-unknown attempt(s) from attempts file into cancel_targets`);
  return pairs.length;
}

async function planRepos(client: DbClient, options: CliOptions, fileTargets: Map<string, Set<string>> | undefined): Promise<Array<{ repo: string; repoId: number }>> {
  if (options.repos.length > 0) {
    const planned: Array<{ repo: string; repoId: number }> = [];
    for (const repo of options.repos) {
      const repoId = await lookupRepoId(client, repo);
      if (repoId === null) {
        console.warn(`Repo ${repo} not found in the database; skipping.`);
        continue;
      }
      planned.push({ repo, repoId });
    }
    return planned;
  }
  if (fileTargets) {
    const planned: Array<{ repo: string; repoId: number }> = [];
    for (const [repo, keys] of fileTargets) {
      const repoId = await lookupRepoId(client, repo);
      if (repoId === null) {
        console.warn(`Repo ${repo} from attempts file not found in the database; skipping its ${keys.size} member(s).`);
        continue;
      }
      planned.push({ repo, repoId });
    }
    return planned;
  }
  const { rows } = await withRetry(() => client.query(PENDING_REPOS_QUERY, [options.minHours]), 3, 2000, undefined, 'SELECT pending repos');
  return rows.map(row => ({ repo: String(row.repo), repoId: Number(row.repo_id) }));
}

interface AnnotationItem {
  message?: unknown;
}

interface CheckRunItem {
  id: number;
  conclusion: string | null;
  started_at: string | null;
}

/** Probe one check run's annotations. Returns the cancelling login on hit,
 * 'gone' on 404/410 (check run no longer exists — idempotent, not a failure),
 * null when no canceller annotation was found. */
async function probeAnnotations(request: RequestFn, owner: string, repoName: string, checkRunId: number, context: string): Promise<{ canceller: string; message: string } | 'gone' | null> {
  for (let page = 1; page <= ANNOTATION_MAX_PAGES; page += 1) {
    let annotations: AnnotationItem[];
    try {
      annotations = await withRetry(async () => {
        const response = await request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
          owner,
          repo: repoName,
          check_run_id: checkRunId,
          per_page: PER_PAGE,
          page,
        });
        if (!Array.isArray(response.data)) {
          throw new InvalidAnnotationsResponseError(`Invalid GitHub response: ${context} page=${page} status=${response.status ?? 'unknown'} expected annotations array`);
        }
        return response.data as AnnotationItem[];
      }, 3, 2000, undefined, `GET check-runs annotations ${context} page=${page}`);
    } catch (err) {
      if (err instanceof MaxApiCallsReachedError || err instanceof RateLimitAbortError) throw err;
      if (isGitHubRateLimitError(err)) throw toRateLimitAbortError(err);
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 410) return 'gone';
      throw err;
    }
    for (const item of annotations) {
      const message = typeof item?.message === 'string' ? item.message : '';
      const login = extractCanceller(message);
      if (login) return { canceller: login, message };
    }
    if (annotations.length < PER_PAGE) break;
  }
  return null;
}

/** Fallback path for attempts without cancelled workflow_jobs rows: list the
 * head sha's check runs and keep the most recent cancelled ones. */
async function listCancelledCheckRuns(request: RequestFn, owner: string, repoName: string, headSha: string, context: string): Promise<CheckRunItem[] | 'gone'> {
  const cancelled: CheckRunItem[] = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    let checkRuns: CheckRunItem[];
    try {
      checkRuns = await withRetry(async () => {
        const response = await request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
          owner,
          repo: repoName,
          ref: headSha,
          filter: 'all',
          per_page: PER_PAGE,
          page,
        });
        const data = response.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== 'object' || !Array.isArray(data.check_runs)) {
          throw new InvalidAnnotationsResponseError(`Invalid GitHub response: ${context} page=${page} status=${response.status ?? 'unknown'} expected check_runs array`);
        }
        return data.check_runs as CheckRunItem[];
      }, 3, 2000, undefined, `GET commits check-runs ${context} page=${page}`);
    } catch (err) {
      if (err instanceof MaxApiCallsReachedError || err instanceof RateLimitAbortError) throw err;
      if (isGitHubRateLimitError(err)) throw toRateLimitAbortError(err);
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 410) return 'gone';
      // 422 "No commit found for SHA": head sha force-pushed away; check runs
      // unreachable — same terminal, idempotent outcome as gone.
      if (status === 422) return 'gone';
      throw err;
    }
    for (const checkRun of checkRuns) {
      if (checkRun.conclusion === 'cancelled') cancelled.push(checkRun);
    }
    if (checkRuns.length < PER_PAGE) break;
  }
  cancelled.sort((a, b) => (Date.parse(b.started_at ?? '') || 0) - (Date.parse(a.started_at ?? '') || 0));
  return cancelled.slice(0, MAX_FALLBACK_CHECK_RUNS);
}

/** Probe one attempt: cancelled jobs by runtime DESC (max 2) -> annotations,
 * hit stops early; without cancelled jobs fall back to head-sha check runs. */
export async function processAttempt(request: RequestFn, client: DbClient, owner: string, repoName: string, target: AttemptTarget): Promise<ProbeOutcome> {
  const context = `repo=${owner}/${repoName} run=${target.runId} attempt=${target.runAttempt}`;
  const { rows: jobRows } = await withRetry(
    () => client.query(
      `SELECT job_id FROM workflow_jobs
WHERE run_id=$1 AND run_attempt=$2 AND conclusion='cancelled'
ORDER BY runtime_seconds DESC NULLS LAST LIMIT 2`,
      [target.runId, target.runAttempt],
    ),
    3, 2000, undefined, `SELECT cancelled jobs ${context}`,
  );
  const jobIds = jobRows.map(row => Number(row.job_id)).filter(id => Number.isFinite(id) && id > 0);

  if (jobIds.length > 0) {
    for (const jobId of jobIds) {
      const hit = await probeAnnotations(request, owner, repoName, jobId, `${context} job=${jobId}`);
      if (hit === 'gone') return { cancelledBy: null, evidence: 'gone', message: null };
      if (hit) return { cancelledBy: hit.canceller, evidence: 'job_annotation', message: hit.message };
    }
    return { cancelledBy: null, evidence: 'none', message: null };
  }

  if (!target.headSha) {
    warn(`${context}: no cancelled workflow_jobs rows and no head_sha; cannot fall back`);
    return { cancelledBy: null, evidence: 'no_cancelled_check_run', message: null };
  }
  const checkRuns = await listCancelledCheckRuns(request, owner, repoName, target.headSha, `${context} sha=${target.headSha.slice(0, 12)}`);
  if (checkRuns === 'gone') return { cancelledBy: null, evidence: 'gone', message: null };
  if (checkRuns.length === 0) return { cancelledBy: null, evidence: 'no_cancelled_check_run', message: null };
  for (const checkRun of checkRuns) {
    const hit = await probeAnnotations(request, owner, repoName, checkRun.id, `${context} check_run=${checkRun.id}`);
    if (hit === 'gone') return { cancelledBy: null, evidence: 'gone', message: null };
    if (hit) return { cancelledBy: hit.canceller, evidence: 'check_run_annotation', message: hit.message };
  }
  return { cancelledBy: null, evidence: 'none', message: null };
}

/** Single-row checkpoint; the IS NULL guard makes concurrent/resumed runs safe. */
export async function persistCancelEvidence(client: DbClient, target: AttemptTarget, outcome: ProbeOutcome): Promise<void> {
  await withRetry(
    () => client.query(
      `UPDATE workflow_attempts
SET cancelled_by=$3, cancel_evidence=$4, cancel_message=$5, cancel_annotation_fetched_at=$6
WHERE run_id=$1 AND run_attempt=$2 AND cancel_annotation_fetched_at IS NULL`,
      [target.runId, target.runAttempt, outcome.cancelledBy, outcome.evidence, outcome.message, new Date().toISOString()],
    ),
    3, 2000, undefined, `UPDATE cancel evidence run=${target.runId} attempt=${target.runAttempt}`,
  );
}

async function processLane(lane: Lane, client: DbClient, concurrency: number, counters: Record<CancelEvidence, number>): Promise<void> {
  const queue = lane.queue;
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (!failed && cursor < queue.length) {
      const target = queue[cursor];
      cursor += 1;
      try {
        const [owner, repoName] = splitRepo(target.repo);
        const outcome = await processAttempt(lane.request, client, owner, repoName, target);
        await persistCancelEvidence(client, target, outcome);
        counters[outcome.evidence] += 1;
        console.log(`Probed ${owner}/${repoName} run=${target.runId} attempt=${target.runAttempt}: evidence=${outcome.evidence}${outcome.cancelledBy ? ` canceller=@${outcome.cancelledBy}` : ''}`);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
}

async function buildLanes(repoQueues: Array<{ repo: string; targets: AttemptTarget[] }>, state: CountedApiState): Promise<Lane[]> {
  const tokens = resolveGitHubTokens();
  const lanesByIdentity = new Map<string, Lane>();
  const laneByToken = new Map<string, Lane>();
  let repoIndex = 0;
  for (const { repo, targets } of repoQueues) {
    if (targets.length === 0) continue;
    const token = resolveTokenForRepo(repo, tokens, repoIndex);
    repoIndex += 1;
    if (!token) {
      throw new Error('No GitHub token found. Set GITHUB_TOKEN, add gh-token.txt, run gh auth login, or set GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>.');
    }
    let lane = laneByToken.get(token);
    if (!lane) {
      const candidate = await buildLane(token, state);
      lane = lanesByIdentity.get(candidate.identity) ?? candidate;
      lanesByIdentity.set(lane.identity, lane);
      laneByToken.set(token, lane);
    }
    lane.queue.push(...targets);
  }
  console.log(`GitHub identity lanes: ${lanesByIdentity.size}; reserve: ${RATE_LIMIT_RESERVE}; probe concurrency per lane: ${CANCEL_FETCH_CONCURRENCY}`);
  for (const lane of lanesByIdentity.values()) {
    log(`Lane ${lane.identity}: budget=${lane.budgetClient.getBudget()}, queued=${lane.queue.length}`);
  }
  return Array.from(lanesByIdentity.values());
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(argv);
  } catch (err) {
    error(err instanceof Error ? err.message : err);
    console.error('Run with --help to see usage.');
    return 1;
  }
  if (options.help) {
    console.log(CLI_HELP);
    return 0;
  }

  resetSharedRetryCount();
  const state: CountedApiState = { calls: 0, max: options.maxApiCalls };
  const counters = Object.fromEntries(CANCEL_EVIDENCES.map(key => [key, 0])) as Record<CancelEvidence, number>;

  let fileTargets: Map<string, Set<string>> | undefined;
  if (options.attemptsFile) {
    try {
      fileTargets = loadAttemptsFileTargets(options.attemptsFile);
    } catch (err) {
      error(err instanceof Error ? err.message : err);
      return 1;
    }
    const members = Array.from(fileTargets.values()).reduce((n, keys) => n + keys.size, 0);
    log(`Attempts file: ${fileTargets.size} repo(s), ${members} cancelled-unknown member(s)`);
  }

  const client = await getDatabaseClient();
  let lanes: Lane[] = [];
  try {
    if (fileTargets) await loadAttemptsIntoTempTable(client, fileTargets);
    const plannedRepos = await planRepos(client, options, fileTargets);
    if (plannedRepos.length === 0) {
      console.log('No candidate repos resolved; nothing to do.');
      return 0;
    }

    // Plan with the global --limit before any GitHub call so a partial run is
    // deterministic and dry-run needs no API requests.
    const useAttemptsFile = Boolean(fileTargets);
    let remaining = options.limit;
    const repoQueues: Array<{ repo: string; limit: number; targets: AttemptTarget[] }> = [];
    for (const { repo, repoId } of plannedRepos) {
      if (remaining <= 0) break;
      const { rows } = await withRetry(
        () => client.query(buildTargetQuery(useAttemptsFile), [repoId, options.minHours, remaining]),
        3, 2000, undefined, `SELECT cancel targets for ${repo}`,
      );
      const targets: AttemptTarget[] = rows.map(row => ({
        repo,
        repoId,
        runId: Number(row.run_id),
        runAttempt: Number(row.run_attempt),
        runtimeSeconds: row.runtime_seconds === null || row.runtime_seconds === undefined ? null : Number(row.runtime_seconds),
        headSha: typeof row.head_sha === 'string' && row.head_sha.length > 0 ? row.head_sha : null,
      }));
      remaining -= targets.length;
      repoQueues.push({ repo, limit: targets.length, targets });
    }
    const totalTargets = repoQueues.reduce((sum, entry) => sum + entry.targets.length, 0);
    if (totalTargets === 0) {
      console.log('All candidate cancelled attempts are already probed (cancel_annotation_fetched_at set); nothing to do.');
      return 0;
    }

    if (options.dryRun) {
      console.log(`Dry run: no API requests, no DB writes. limit=${options.limit}, min-hours=${options.minHours}`);
      let estimatedTotal = 0;
      for (const { repo, limit } of repoQueues) {
        if (limit === 0) continue;
        const repoId = plannedRepos.find(entry => entry.repo === repo)!.repoId;
        const { rows } = await client.query(buildDryRunStatsQuery(useAttemptsFile), [repoId, options.minHours, limit]);
        const stats = rows[0] as { main_annotation_calls: number; fallback_attempts: number; attempts: number };
        const estimated = Number(stats.main_annotation_calls) + Number(stats.fallback_attempts) * (1 + MAX_FALLBACK_CHECK_RUNS);
        estimatedTotal += estimated;
        console.log(`  repo=${repo} planned=${stats.attempts} fallbackAttempts=${stats.fallback_attempts} estimatedApiCalls<=${estimated}`);
      }
      console.log(`Dry run total: ${totalTargets} attempt(s), estimatedApiCalls<=${estimatedTotal}`);
      return 0;
    }

    lanes = await buildLanes(repoQueues, state);
    await Promise.all(lanes.map(lane => processLane(lane, client, CANCEL_FETCH_CONCURRENCY, counters)));
    const probed = CANCEL_EVIDENCES.reduce((sum, key) => sum + counters[key], 0);
    console.log(`Cancel-annotation collection summary: probed=${probed}/${totalTargets}, evidence=${JSON.stringify(counters)}, apiCalls=${state.calls}, retries=${getSharedRetryCount()}`);
    return 0;
  } catch (err) {
    const probed = CANCEL_EVIDENCES.reduce((sum, key) => sum + counters[key], 0);
    if (err instanceof RateLimitAbortError || err instanceof MaxApiCallsReachedError || isGitHubRateLimitError(err)) {
      console.log(err instanceof Error ? err.message : String(err));
      console.log(`Stopping gracefully after ${state.calls} API call(s): probed=${probed} attempt(s) are checkpointed.`);
      for (const lane of lanes) {
        console.log(`Lane ${lane.identity}: remainingBudget=${lane.budgetClient.getBudget()}`);
      }
      console.log('Re-run the same command to resume from cancel_annotation_fetched_at IS NULL.');
      return 3;
    }
    error('Cancel-annotation collection failed:', err);
    console.error(`Progress before failure: probed=${probed}, apiCalls=${state.calls}`);
    return 1;
  } finally {
    client.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().then(code => process.exit(code)).catch(err => {
    error(err);
    process.exit(1);
  });
}
