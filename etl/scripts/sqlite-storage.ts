/**
 * SQLite (local) storage adapter for ETL pipeline.
 *
 * Each repository gets its own database file under `etl/data/<owner>-<repo>.db`.
 * Mirrors the Turso storage API so that ETL can write to both backends
 * simultaneously.  When Turso write quota is exhausted, data is still
 * persisted locally.
 *
 * Database files are auto-created on first write.  If a compressed
 * `<owner>-<repo>.db.xz` exists in the repo, it is auto-decompressed.
 */

import { createClient, type Client, type InValue } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Step } from '../../src/lib/types.ts';

/* ------------------------------------------------------------------ */
/*  Types (mirrored from turso-storage.ts)                              */
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

/* ------------------------------------------------------------------ */
/*  Constants & env                                                    */
/* ------------------------------------------------------------------ */

const SQLITE_PAGE_SIZE = 1000;

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

/* ------------------------------------------------------------------ */
/*  Per-repo DB path resolution & client cache                         */
/* ------------------------------------------------------------------ */

const clientCache = new Map<string, Client>();

/** Resolve the data directory. */
function getDataDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const scriptsDir = path.dirname(__filename);
  const etlDir = path.dirname(scriptsDir);
  const dataDir = path.join(etlDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** Convert `owner/repo` → `<owner>-<repo>.db` path. */
function repoToDbPath(repo: string): string {
  const [owner, repoName] = repo.split('/');
  const safe = `${owner}-${repoName}.db`;
  const overrideDir = process.env.SQLITE_DATA_DIR;
  const dataDir = overrideDir ?? getDataDir();
  return path.join(dataDir, safe);
}

/** Get (or create) a per-repo SQLite client. */
function getRepoClient(repo: string): Client {
  const cached = clientCache.get(repo);
  if (cached) return cached;

  const dbPath = repoToDbPath(repo);
  const client = createClient({ url: `file:${dbPath}` });
  clientCache.set(repo, client);
  return client;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id   INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  repo  TEXT NOT NULL,
  UNIQUE(owner, repo)
);

CREATE TABLE IF NOT EXISTS runs (
  id                 INTEGER PRIMARY KEY,
  repo_id            INTEGER NOT NULL,
  name               TEXT,
  head_branch        TEXT,
  head_sha           TEXT,
  status             TEXT,
  conclusion         TEXT,
  event              TEXT,
  created_at         TEXT,
  updated_at         TEXT,
  html_url           TEXT,
  duration_seconds   REAL,
  date               TEXT,
  steps_checked_at   TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id                      INTEGER PRIMARY KEY,
  run_id                  INTEGER NOT NULL,
  name                    TEXT,
  status                  TEXT,
  conclusion              TEXT,
  created_at              TEXT,
  started_at              TEXT,
  completed_at            TEXT,
  html_url                TEXT,
  queue_duration_seconds  REAL,
  duration_seconds        REAL
);

CREATE TABLE IF NOT EXISTS steps (
  job_id            INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  name              TEXT,
  status            TEXT,
  conclusion        TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  duration_seconds  REAL,
  PRIMARY KEY (job_id, number)
);

CREATE TABLE IF NOT EXISTS pr_metrics (
  id                          INTEGER PRIMARY KEY,
  repo_id                     INTEGER NOT NULL,
  pr_number                   INTEGER NOT NULL,
  title                       TEXT,
  branch                      TEXT,
  author                      TEXT,
  state                       TEXT,
  html_url                    TEXT,
  created_at                  TEXT,
  ci_started_at               TEXT,
  ci_completed_at             TEXT,
  merged_at                   TEXT,
  partial_ci_history          INTEGER DEFAULT 0,
  time_to_ci_start_seconds    REAL,
  ci_duration_seconds         REAL,
  time_to_merge_seconds       REAL,
  merge_lead_time_seconds     REAL,
  workflow_count              INTEGER,
  successful_workflow_count   INTEGER,
  conclusion                  TEXT,
  UNIQUE(repo_id, pr_number)
);

CREATE TABLE IF NOT EXISTS pr_workflows (
  pr_metric_id INTEGER NOT NULL,
  run_id       INTEGER NOT NULL,
  PRIMARY KEY (pr_metric_id, run_id)
);

CREATE TABLE IF NOT EXISTS pr_resolution_cache (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL,
  head_sha      TEXT NOT NULL,
  pr_number     INTEGER,
  source        TEXT,
  status        TEXT,
  error_message TEXT,
  attempted_at  TEXT,
  resolved_at   TEXT,
  UNIQUE(repo_id, head_sha)
);

CREATE TABLE IF NOT EXISTS collection_state (
  repo_id           INTEGER PRIMARY KEY,
  backfill_cursor   TEXT,
  history_complete  INTEGER DEFAULT 0,
  latest_date       TEXT,
  retention_days    INTEGER DEFAULT 90,
  last_updated      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date);
CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date);
CREATE INDEX IF NOT EXISTS idx_runs_event ON runs(event);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo ON pr_metrics(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo_ci ON pr_metrics(repo_id, ci_completed_at);
CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_repo_sha ON pr_resolution_cache(repo_id, head_sha);
`;

async function ensureRepoSchema(client: Client): Promise<void> {
  const statements = SQLITE_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const sql of statements) {
    await client.execute({ sql, args: [] });
  }
}

/** Public helper — guarantees the schema is initialized for a given repo. */
export async function initSqlite(repo: string): Promise<string> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  return repoToDbPath(repo);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

/** Upsert a single row into `repos` and return its id. */
async function ensureRepo(client: Client, owner: string, repo: string): Promise<number> {
  await client.execute({
    sql: `INSERT INTO repos (owner, repo) VALUES (?, ?) ON CONFLICT(owner, repo) DO NOTHING`,
    args: [owner, repo],
  });

  const { rows } = await client.execute({
    sql: `SELECT id FROM repos WHERE owner = ? AND repo = ?`,
    args: [owner, repo],
  });

  if (rows.length === 0) {
    throw new Error(`Failed to ensure repository ${owner}/${repo} in SQLite`);
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
/*  Public API — mirrors turso-storage.ts                              */
/* ------------------------------------------------------------------ */

export async function writeRunsToSqlite(repo: string, runs: RunRow[], date: string): Promise<void> {
  if (runs.length === 0) return;

  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
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
          run.id, repoId, run.name, run.head_branch, run.head_sha ?? null,
          run.status, run.conclusion ?? null, run.event ?? null,
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
            conclusion: job.conclusion ?? null, created_at: job.created_at,
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
                status: step.status, conclusion: step.conclusion ?? null,
                started_at: step.started_at ?? null,
                completed_at: step.completed_at ?? null,
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

export async function getExistingRunIdsWithStepsFromSqlite(repo: string): Promise<Map<number, string>> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
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
      args: [repoId, SQLITE_PAGE_SIZE, offset],
    });

    for (const row of rows) {
      runIds.set(Number(row.id as number), row.updated_at as string);
    }

    if (rows.length < SQLITE_PAGE_SIZE) break;
    offset += SQLITE_PAGE_SIZE;
  }

  return runIds;
}

export async function readCollectionStateFromSqlite(repo: string): Promise<CollectionState | null> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
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

export async function writeCollectionStateToSqlite(repo: string, state: CollectionState): Promise<void> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
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

export async function getCollectedDatesFromSqlite(repo: string): Promise<string[]> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(client, owner, repoName);

  const { rows } = await client.execute({
    sql: `SELECT DISTINCT date FROM runs WHERE repo_id = ? ORDER BY date DESC`,
    args: [repoId],
  });

  return rows.map((r) => r.date as string);
}

export async function readPullRequestResolutionCacheFromSqlite(
  repo: string,
  shas: string[],
): Promise<Map<string, PullRequestResolutionCacheRecord>> {
  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  if (shas.length === 0) return new Map();

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

export async function writePullRequestResolutionCacheToSqlite(
  repo: string,
  entries: PullRequestResolutionCacheEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

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

export async function writePrWorkflowsToSqlite(repo: string, prWorkflows: Map<number, number[]>): Promise<void> {
  if (prWorkflows.size === 0) return;

  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

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

export async function writePrMetricsToSqlite(repo: string, prs: PrMetricsSummary[]): Promise<void> {
  if (prs.length === 0) return;

  const client = getRepoClient(repo);
  await ensureRepoSchema(client);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  const prRows = prs.map((pr) => ({
    repo_id: repoId,
    pr_number: pr.number,
    title: pr.title,
    branch: pr.branch,
    author: pr.author ?? null,
    state: pr.state,
    html_url: pr.html_url,
    created_at: pr.created_at,
    ci_started_at: pr.ci_started_at ?? null,
    ci_completed_at: pr.ci_completed_at ?? null,
    merged_at: pr.merged_at ?? null,
    partial_ci_history: pr.partialCiHistory ? 1 : 0,
    time_to_ci_start_seconds: pr.timeToCiStartInSeconds ?? null,
    ci_duration_seconds: pr.ciDurationInSeconds ?? null,
    time_to_merge_seconds: pr.timeToMergeInSeconds ?? null,
    merge_lead_time_seconds: pr.mergeLeadTimeInSeconds ?? null,
    workflow_count: pr.workflowCount,
    successful_workflow_count: pr.successfulWorkflowCount,
    conclusion: pr.conclusion ?? null,
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
