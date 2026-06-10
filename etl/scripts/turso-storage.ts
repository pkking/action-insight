/**
 * Turso (libSQL) storage adapter for ETL pipeline.
 * Writes runs, jobs, steps, PR metrics, and related data to Turso database.
 *
 * Supports both local SQLite (file:./data.db) and remote Turso (libsqls://...)
 * via the same @libsql/client API.
 */

import { createClient, type Client, type InValue } from '@libsql/client';
import type { Step } from '../../src/lib/types.ts';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface JobRow {
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
  steps?: Step[];
}

interface RunRow {
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
  jobs?: JobRow[];
}

interface PrMetricsSummary {
  number: number;
  title: string;
  branch: string;
  author?: string;
  state: string;
  html_url: string;
  created_at: string;
  ci_started_at?: string;
  ci_completed_at?: string;
  merged_at?: string | null;
  partialCiHistory: boolean;
  timeToCiStartInSeconds?: number;
  ciDurationInSeconds?: number;
  timeToMergeInSeconds?: number;
  mergeLeadTimeInSeconds?: number;
  workflowCount: number;
  successfulWorkflowCount: number;
  conclusion: string;
}

export type PullRequestResolutionStatus = 'resolved' | 'not_found' | 'failed' | 'rate_limited';

export interface PullRequestResolutionCacheEntry {
  head_sha: string;
  pr_number?: number | null;
  source?: string;
  status?: PullRequestResolutionStatus;
  error_message?: string | null;
}

export interface PullRequestResolutionCacheRecord {
  head_sha: string;
  pr_number: number | null;
  source: string;
  status: PullRequestResolutionStatus;
  error_message: string | null;
}

export interface CollectionState {
  backfillCursor: string | null;
  historyComplete: boolean;
  latestDate: string | null;
  retentionDays: number;
  lastUpdated: string | null;
}

export interface EtlFreshnessReport {
  latestRunCreatedAt: string | null;
  latestCiCompletedAt: string | null;
  lagInSeconds: number | null;
  isStale: boolean;
}

/* ------------------------------------------------------------------ */
/*  Client singleton                                                   */
/* ------------------------------------------------------------------ */

let cachedClient: Client | null = null;
const TURSO_PAGE_SIZE = 1000;

const PR_RESOLUTION_SOURCE_PRIORITY: Record<string, number> = {
  run_payload: 1,
  workflow_run: 1,
  search_api: 2,
  commits_api: 3,
};

const RUN_UPSERT_BATCH_SIZE = readPositiveIntEnv('RUN_UPSERT_BATCH_SIZE', 200);
const JOB_UPSERT_BATCH_SIZE = readPositiveIntEnv('JOB_UPSERT_BATCH_SIZE', 500);
const STEP_UPSERT_BATCH_SIZE = readPositiveIntEnv('STEP_UPSERT_BATCH_SIZE', 500);
const CACHE_UPSERT_BATCH_SIZE = readPositiveIntEnv('CACHE_UPSERT_BATCH_SIZE', 100);
const PR_METRIC_UPSERT_BATCH_SIZE = readPositiveIntEnv('PR_METRIC_UPSERT_BATCH_SIZE', 100);
const PR_WORKFLOW_UPSERT_BATCH_SIZE = readPositiveIntEnv('PR_WORKFLOW_UPSERT_BATCH_SIZE', 500);

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

function getTursoClient(): Client | null {
  if (cachedClient) return cachedClient;

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    // Backward compat: if only TURSO_AUTH_TOKEN is set without URL, skip
    return null;
  }

  cachedClient = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return cachedClient;
}

function requireTursoClient(repo: string): Client {
  const client = getTursoClient();
  if (!client) {
    throw new Error(`Turso is not configured for ${repo} (set TURSO_DATABASE_URL)`);
  }
  return client;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

async function ensureRepo(client: Client, owner: string, repo: string): Promise<number> {
  // Upsert using INSERT OR REPLACE
  await client.execute({
    sql: `INSERT INTO repos (owner, repo) VALUES (?, ?)
          ON CONFLICT(owner, repo) DO NOTHING`,
    args: [owner, repo],
  });

  const { rows } = await client.execute({
    sql: `SELECT id FROM repos WHERE owner = ? AND repo = ?`,
    args: [owner, repo],
  });

  if (rows.length === 0) {
    throw new Error(`Failed to ensure repository ${owner}/${repo} in Turso`);
  }

  return Number(rows[0].id as number);
}

function getPrResolutionSourcePriority(source?: string): number {
  return PR_RESOLUTION_SOURCE_PRIORITY[source ?? 'commits_api'] ?? 0;
}

function getPrResolutionStatus(entry: PullRequestResolutionCacheEntry): PullRequestResolutionStatus {
  if (entry.status) return entry.status;
  return typeof entry.pr_number === 'number' ? 'resolved' : 'failed';
}

function isPrResolutionStatus(value: unknown): value is PullRequestResolutionStatus {
  return value === 'resolved' || value === 'not_found' || value === 'failed' || value === 'rate_limited';
}

function shouldWritePrResolutionCacheEntry(
  incoming: PullRequestResolutionCacheEntry,
  existing?: { source: string; status: PullRequestResolutionStatus; error_message: string | null },
): boolean {
  if (!existing) return true;

  const incomingStatus = getPrResolutionStatus(incoming);
  if (existing.status === 'resolved') {
    return (
      incomingStatus === 'resolved' &&
      getPrResolutionSourcePriority(incoming.source) >= getPrResolutionSourcePriority(existing.source)
    );
  }

  if (incomingStatus === 'resolved' || incomingStatus === 'not_found') return true;
  if (existing.status === 'not_found') return false;

  return true;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function writeRunsToTurso(repo: string, runs: RunRow[], date: string): Promise<void> {
  if (runs.length === 0) return;

  const client = requireTursoClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  const tx = await client.transaction('write');
  try {
    // Write runs
    for (const batch of chunkArray(runs, RUN_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((run) => ({
        sql: `INSERT INTO runs (id, repo_id, name, head_branch, head_sha, status, conclusion, event, created_at, updated_at, html_url, duration_seconds, date, steps_checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status=excluded.status, conclusion=excluded.conclusion, event=excluded.event,
                updated_at=excluded.updated_at, html_url=excluded.html_url,
                duration_seconds=excluded.duration_seconds, steps_checked_at=excluded.steps_checked_at`,
        args: [
          run.id, repoId, run.name, run.head_branch, run.head_sha || null,
          run.status, run.conclusion || null, run.event || null,
          run.created_at, run.updated_at, run.html_url, run.durationInSeconds,
          date, run.updated_at,
        ] as InValue[],
      }));
      await tx.batch(stmts);
    }

    // Write jobs
    const jobRows: {
      id: number; run_id: number; name: string; status: string;
      conclusion: string | null; created_at: string; started_at: string;
      completed_at: string; html_url: string; queue_duration_seconds: number;
      duration_seconds: number;
    }[] = [];

    for (const run of runs) {
      if (run.jobs) {
        for (const job of run.jobs) {
          jobRows.push({
            id: job.id, run_id: run.id, name: job.name, status: job.status,
            conclusion: job.conclusion || null, created_at: job.created_at,
            started_at: job.started_at, completed_at: job.completed_at,
            html_url: job.html_url, queue_duration_seconds: job.queueDurationInSeconds,
            duration_seconds: job.durationInSeconds,
          });
        }
      }
    }

    for (const batch of chunkArray(jobRows, JOB_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((job) => ({
        sql: `INSERT INTO jobs (id, run_id, name, status, conclusion, created_at, started_at, completed_at, html_url, queue_duration_seconds, duration_seconds)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status=excluded.status, conclusion=excluded.conclusion,
                started_at=excluded.started_at, completed_at=excluded.completed_at,
                html_url=excluded.html_url, queue_duration_seconds=excluded.queue_duration_seconds,
                duration_seconds=excluded.duration_seconds`,
        args: [
          job.id, job.run_id, job.name, job.status, job.conclusion,
          job.created_at, job.started_at, job.completed_at, job.html_url,
          job.queue_duration_seconds, job.duration_seconds,
        ] as InValue[],
      }));
      await tx.batch(stmts);
    }

    // Write steps
    const stepRows: {
      job_id: number; number: number; name: string; status: string;
      conclusion: string | null; started_at: string | null;
      completed_at: string | null; duration_seconds: number;
    }[] = [];

    for (const run of runs) {
      if (run.jobs) {
        for (const job of run.jobs) {
          if (job.steps) {
            for (const step of job.steps) {
              stepRows.push({
                job_id: job.id, number: step.number, name: step.name,
                status: step.status, conclusion: step.conclusion || null,
                started_at: step.started_at || null,
                completed_at: step.completed_at || null,
                duration_seconds: step.duration_seconds ?? 0,
              });
            }
          }
        }
      }
    }

    for (const batch of chunkArray(stepRows, STEP_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((step) => ({
        sql: `INSERT INTO steps (job_id, number, name, status, conclusion, started_at, completed_at, duration_seconds)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(job_id, number) DO UPDATE SET
                status=excluded.status, conclusion=excluded.conclusion,
                started_at=excluded.started_at, completed_at=excluded.completed_at,
                duration_seconds=excluded.duration_seconds`,
        args: [
          step.job_id, step.number, step.name, step.status, step.conclusion,
          step.started_at, step.completed_at, step.duration_seconds,
        ] as InValue[],
      }));
      await tx.batch(stmts);
    }

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

export async function getExistingRunIdsFromTurso(repo: string): Promise<Set<number>> {
  const client = getTursoClient();
  if (!client) return new Set();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const { rows } = await client.execute({
    sql: `SELECT id FROM runs WHERE repo_id = ?`,
    args: [repoId],
  });

  return new Set(rows.map((r) => Number(r.id as number)));
}

export async function getExistingRunIdsWithJobsFromTurso(repo: string): Promise<Set<number>> {
  const client = getTursoClient();
  if (!client) return new Set();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const runIds = new Set<number>();
  let offset = 0;

  while (true) {
    const { rows } = await client.execute({
      sql: 'SELECT r.id FROM runs r WHERE r.repo_id = ? AND EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id) ORDER BY r.id LIMIT ? OFFSET ?',
      args: [repoId, TURSO_PAGE_SIZE, offset],
    });

    for (const row of rows) {
      runIds.add(Number(row.id as number));
    }

    if (rows.length < TURSO_PAGE_SIZE) break;
    offset += TURSO_PAGE_SIZE;
  }

  return runIds;
}

export async function getExistingRunIdsWithStepsFromTurso(repo: string): Promise<Map<number, string>> {
  const client = getTursoClient();
  if (!client) return new Map();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const runIds = new Map<number, string>();
  let offset = 0;

  while (true) {
    const { rows } = await client.execute({
      sql: `SELECT r.id, r.updated_at FROM runs r
            WHERE r.repo_id = ? AND r.steps_checked_at IS NOT NULL
              AND r.steps_checked_at >= r.updated_at
            ORDER BY r.id LIMIT ? OFFSET ?`,
      args: [repoId, TURSO_PAGE_SIZE, offset],
    });

    for (const row of rows) {
      runIds.set(Number(row.id as number), row.updated_at as string);
    }

    if (rows.length < TURSO_PAGE_SIZE) break;
    offset += TURSO_PAGE_SIZE;
  }

  return runIds;
}

export async function readPullRequestResolutionCacheFromTurso(
  repo: string,
  shas: string[],
): Promise<Map<string, PullRequestResolutionCacheRecord>> {
  const client = getTursoClient();
  if (!client || shas.length === 0) return new Map();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const cached = new Map<string, PullRequestResolutionCacheRecord>();
  const uniqueShas = Array.from(new Set(shas));

  for (const batch of chunkArray(uniqueShas, CACHE_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    const { rows } = await client.execute({
      sql: `SELECT head_sha, pr_number, source, status, error_message
            FROM pr_resolution_cache
            WHERE repo_id = ? AND head_sha IN (${placeholders})`,
      args: [repoId, ...batch],
    });

    for (const row of rows) {
      const headSha = row.head_sha as string;
      const prNumber = typeof row.pr_number === 'number' ? row.pr_number : null;
      const status = isPrResolutionStatus(row.status)
        ? row.status
        : prNumber === null ? 'failed' : 'resolved';

      cached.set(headSha, {
        head_sha: headSha,
        pr_number: prNumber,
        source: typeof row.source === 'string' ? row.source : 'commits_api',
        status,
        error_message: typeof row.error_message === 'string' ? row.error_message : null,
      });
    }
  }

  return cached;
}

export async function writePullRequestResolutionCacheToTurso(
  repo: string,
  entries: PullRequestResolutionCacheEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const client = requireTursoClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  // Deduplicate by head_sha, keeping best source
  const entriesBySha = new Map<string, PullRequestResolutionCacheEntry>();
  for (const entry of entries) {
    const existing = entriesBySha.get(entry.head_sha);
    const incomingStatus = getPrResolutionStatus(entry);
    const existingStatus = existing ? getPrResolutionStatus(existing) : undefined;
    if (
      !existing ||
      (incomingStatus === 'resolved' &&
        (existingStatus !== 'resolved' ||
          getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source))) ||
      (existingStatus !== 'resolved' &&
        getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source))
    ) {
      entriesBySha.set(entry.head_sha, entry);
    }
  }

  // Fetch existing entries for priority comparison
  const uniqueShas = Array.from(entriesBySha.keys());
  const existingEntries = new Map<string, { source: string; status: PullRequestResolutionStatus; error_message: string | null }>();

  for (const batch of chunkArray(uniqueShas, CACHE_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    const { rows } = await client.execute({
      sql: `SELECT head_sha, pr_number, source, status, error_message
            FROM pr_resolution_cache
            WHERE repo_id = ? AND head_sha IN (${placeholders})`,
      args: [repoId, ...batch],
    });

    for (const row of rows) {
      existingEntries.set(row.head_sha as string, {
        source: row.source as string,
        status: isPrResolutionStatus(row.status)
          ? row.status
          : typeof row.pr_number === 'number' ? 'resolved' : 'failed',
        error_message: typeof row.error_message === 'string' ? row.error_message : null,
      });
    }
  }

  // Filter and write
  const now = new Date().toISOString();
  const rowsToInsert = Array.from(entriesBySha.values())
    .filter((entry) => {
      const existing = existingEntries.get(entry.head_sha);
      return shouldWritePrResolutionCacheEntry(entry, existing);
    })
    .map((entry) => {
      const status = getPrResolutionStatus(entry);
      return {
        repo_id: repoId,
        head_sha: entry.head_sha,
        pr_number: entry.pr_number ?? null,
        source: entry.source ?? 'commits_api',
        status,
        error_message: entry.error_message ?? null,
        attempted_at: now,
        resolved_at: status === 'resolved' ? now : null,
      };
    });

  if (rowsToInsert.length === 0) return;

  const tx = await client.transaction('write');
  try {
    for (const batch of chunkArray(rowsToInsert, CACHE_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((r) => ({
        sql: `INSERT INTO pr_resolution_cache (repo_id, head_sha, pr_number, source, status, error_message, attempted_at, resolved_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(repo_id, head_sha) DO UPDATE SET
                pr_number=excluded.pr_number, source=excluded.source, status=excluded.status,
                error_message=excluded.error_message, attempted_at=excluded.attempted_at,
                resolved_at=excluded.resolved_at`,
        args: [
          r.repo_id, r.head_sha, r.pr_number, r.source, r.status,
          r.error_message, r.attempted_at, r.resolved_at,
        ] as InValue[],
      }));
      await tx.batch(stmts);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

export async function writePrWorkflowsToTurso(repo: string, prWorkflows: Map<number, number[]>): Promise<void> {
  if (prWorkflows.size === 0) return;

  const client = requireTursoClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  // Look up pr_metric IDs by pr_number
  const prNumberToId = new Map<number, number>();
  const prNumbers = Array.from(prWorkflows.keys());

  for (const batch of chunkArray(prNumbers, PR_METRIC_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    const { rows } = await client.execute({
      sql: `SELECT id, pr_number FROM pr_metrics WHERE repo_id = ? AND pr_number IN (${placeholders})`,
      args: [repoId, ...batch],
    });

    for (const row of rows) {
      prNumberToId.set(row.pr_number as number, Number(row.id as number));
    }
  }

  // Build rows
  const workflowRows: { pr_metric_id: number; run_id: number }[] = [];
  for (const [prNumber, runIds] of prWorkflows.entries()) {
    const prMetricId = prNumberToId.get(prNumber);
    if (!prMetricId) continue;
    for (const runId of runIds) {
      workflowRows.push({ pr_metric_id: prMetricId, run_id: runId });
    }
  }

  if (workflowRows.length === 0) return;

  const tx = await client.transaction('write');
  try {
    for (const batch of chunkArray(workflowRows, PR_WORKFLOW_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((r) => ({
        sql: `INSERT INTO pr_workflows (pr_metric_id, run_id) VALUES (?, ?)
              ON CONFLICT(pr_metric_id, run_id) DO NOTHING`,
        args: [r.pr_metric_id, r.run_id] as InValue[],
      }));
      await tx.batch(stmts);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

export async function writePrMetricsToTurso(repo: string, prs: PrMetricsSummary[]): Promise<void> {
  if (prs.length === 0) return;

  const client = requireTursoClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  const prRows = prs.map((pr) => ({
    repo_id: repoId,
    pr_number: pr.number,
    title: pr.title,
    branch: pr.branch,
    author: pr.author || null,
    state: pr.state,
    html_url: pr.html_url,
    created_at: pr.created_at,
    ci_started_at: pr.ci_started_at || null,
    ci_completed_at: pr.ci_completed_at || null,
    merged_at: pr.merged_at || null,
    partial_ci_history: pr.partialCiHistory ? 1 : 0,
    time_to_ci_start_seconds: pr.timeToCiStartInSeconds || null,
    ci_duration_seconds: pr.ciDurationInSeconds || null,
    time_to_merge_seconds: pr.timeToMergeInSeconds || null,
    merge_lead_time_seconds: pr.mergeLeadTimeInSeconds || null,
    workflow_count: pr.workflowCount,
    successful_workflow_count: pr.successfulWorkflowCount,
    conclusion: pr.conclusion || null,
  }));

  const tx = await client.transaction('write');
  try {
    for (const batch of chunkArray(prRows, PR_METRIC_UPSERT_BATCH_SIZE)) {
      const stmts = batch.map((r) => ({
        sql: `INSERT INTO pr_metrics (repo_id, pr_number, title, branch, author, state, html_url, created_at, ci_started_at, ci_completed_at, merged_at, partial_ci_history, time_to_ci_start_seconds, ci_duration_seconds, time_to_merge_seconds, merge_lead_time_seconds, workflow_count, successful_workflow_count, conclusion)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(repo_id, pr_number) DO UPDATE SET
                title=excluded.title, branch=excluded.branch, author=excluded.author,
                state=excluded.state, html_url=excluded.html_url, created_at=excluded.created_at,
                ci_started_at=excluded.ci_started_at, ci_completed_at=excluded.ci_completed_at,
                merged_at=excluded.merged_at, partial_ci_history=excluded.partial_ci_history,
                time_to_ci_start_seconds=excluded.time_to_ci_start_seconds,
                ci_duration_seconds=excluded.ci_duration_seconds,
                time_to_merge_seconds=excluded.time_to_merge_seconds,
                merge_lead_time_seconds=excluded.merge_lead_time_seconds,
                workflow_count=excluded.workflow_count,
                successful_workflow_count=excluded.successful_workflow_count,
                conclusion=excluded.conclusion`,
        args: [
          r.repo_id, r.pr_number, r.title, r.branch, r.author, r.state,
          r.html_url, r.created_at, r.ci_started_at, r.ci_completed_at,
          r.merged_at, r.partial_ci_history, r.time_to_ci_start_seconds,
          r.ci_duration_seconds, r.time_to_merge_seconds, r.merge_lead_time_seconds,
          r.workflow_count, r.successful_workflow_count, r.conclusion,
        ] as InValue[],
      }));
      await tx.batch(stmts);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

export async function readCollectionState(repo: string): Promise<CollectionState | null> {
  const client = getTursoClient();
  if (!client) return null;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const { rows } = await client.execute({
    sql: `SELECT * FROM collection_state WHERE repo_id = ?`,
    args: [repoId],
  });

  if (rows.length === 0) return null;

  const data = rows[0];
  return {
    backfillCursor: ((data.backfill_cursor as string) || '').slice(0, 10) || null,
    historyComplete: Boolean(data.history_complete),
    latestDate: ((data.latest_date as string) || '').slice(0, 10) || null,
    retentionDays: Number(data.retention_days ?? 90),
    lastUpdated: (data.last_updated as string) || null,
  };
}

export async function writeCollectionState(repo: string, state: CollectionState): Promise<void> {
  const client = requireTursoClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  await client.execute({
    sql: `INSERT INTO collection_state (repo_id, backfill_cursor, history_complete, latest_date, retention_days, last_updated)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id) DO UPDATE SET
            backfill_cursor=excluded.backfill_cursor,
            history_complete=excluded.history_complete,
            latest_date=excluded.latest_date,
            retention_days=excluded.retention_days,
            last_updated=excluded.last_updated`,
    args: [
      repoId,
      state.backfillCursor,
      state.historyComplete ? 1 : 0,
      state.latestDate,
      state.retentionDays,
      state.lastUpdated ?? new Date().toISOString(),
    ] as InValue[],
  });
}

export async function getCollectedDatesFromTurso(repo: string): Promise<string[]> {
  const client = getTursoClient();
  if (!client) return [];

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const { rows } = await client.execute({
    sql: `SELECT DISTINCT date FROM runs WHERE repo_id = ? ORDER BY date DESC`,
    args: [repoId],
  });

  return rows.map((r) => r.date as string);
}

export function formatFreshnessReport(report: EtlFreshnessReport, repo: string): string {
  if (report.isStale) {
    const lagDisplay = report.lagInSeconds !== null ? `${Math.round(report.lagInSeconds / 3600)}h` : 'infinite';
    return `ETL freshness: ${repo} pr_metrics lag behind raw runs by ${lagDisplay} (runs: ${report.latestRunCreatedAt}, metrics: ${report.latestCiCompletedAt})`;
  }
  if (report.latestRunCreatedAt && report.latestCiCompletedAt) {
    return `ETL freshness: ${repo} pr_metrics in sync (lag: ${Math.max(0, Math.round(report.lagInSeconds! / 60))}min)`;
  }
  return `ETL freshness: ${repo} runs=${report.latestRunCreatedAt ?? 'none'}, metrics=${report.latestCiCompletedAt ?? 'none'}`;
}

export async function checkEtlFreshness(repo: string, staleThresholdSeconds = 86400): Promise<EtlFreshnessReport | null> {
  const client = getTursoClient();
  if (!client) return null;

  const parts = repo.split('/');
  if (parts.length !== 2) {
    console.error(`Invalid repo format for freshness check: ${repo}. Expected owner/repo`);
    return null;
  }

  const repoId = await ensureRepo(client, parts[0], parts[1]);

  const prRelatedEvents = ['pull_request', 'pull_request_target', 'pull_request_review', 'push'];
  const eventPlaceholders = prRelatedEvents.map(() => '?').join(',');

  const [runsResult, metricsResult] = await Promise.all([
    client.execute({
      sql: `SELECT created_at FROM runs WHERE repo_id = ? AND event IN (${eventPlaceholders})
            ORDER BY created_at DESC LIMIT 1`,
      args: [repoId, ...prRelatedEvents],
    }),
    client.execute({
      sql: `SELECT ci_completed_at FROM pr_metrics WHERE repo_id = ?
            AND ci_completed_at IS NOT NULL ORDER BY ci_completed_at DESC LIMIT 1`,
      args: [repoId],
    }),
  ]);

  const latestRunCreatedAt = runsResult.rows.length > 0 ? (runsResult.rows[0].created_at as string) : null;
  const latestCiCompletedAt = metricsResult.rows.length > 0 ? (metricsResult.rows[0].ci_completed_at as string) : null;

  let lagInSeconds: number | null = null;
  if (latestRunCreatedAt && latestCiCompletedAt) {
    lagInSeconds = (new Date(latestRunCreatedAt).getTime() - new Date(latestCiCompletedAt).getTime()) / 1000;
  }

  return {
    latestRunCreatedAt,
    latestCiCompletedAt,
    lagInSeconds,
    isStale: (latestRunCreatedAt !== null && latestCiCompletedAt === null) ||
      (lagInSeconds !== null && lagInSeconds > staleThresholdSeconds),
  };
}
