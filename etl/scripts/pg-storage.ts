/**
 * PostgreSQL storage adapter for ETL pipeline.
 * Writes runs, jobs, steps, PR metrics, and related data to a local PG database.
 */

import type { PoolClient } from 'pg';
import type { Step } from '../../src/lib/types.ts';
import type { WorkflowAttemptRow } from './workflow-attempts.ts';
import { writeWorkflowAttemptsToClient, writePrWorkflowAttemptsToClient } from './workflow-attempt-writes.ts';
import { getDatabaseClient, type DbClient } from '../../src/lib/db.ts';
import { toPgSql, pgPlaceholders } from './pg-utils.ts';

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
  labels?: string[];
  runner_id?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  resource_model?: string;
  resource_count?: number;
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
  runAttempt?: number;
  run_started_at?: string;
  queueDurationInSeconds?: number;
  runtimeInSeconds?: number;
  workflowFile?: string;
  workflowRef?: string;
  workflowPath?: string;
  workflowParseStatus?: string;
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
/*  Client helpers                                                     */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 1000;

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

/** Transition shim: returns a PoolClient for code still calling getDatabaseClient(). */
export async function getDatabaseClient(): Promise<PoolClient | null> {
  const url = process.env.PG_DATABASE_URL;
  if (!url) return null;
  return getDatabaseClient();
}

async function requireClient(repo: string): Promise<PoolClient> {
  const url = process.env.PG_DATABASE_URL;
  if (!url) {
    throw new Error(`Database is not configured for ${repo} (set PG_DATABASE_URL)`);
  }
  return getDatabaseClient();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

/** Helper: run a query on a client, converting ? placeholders to $N. */
async function execQuery(client: { query: PoolClient['query'] }, sql: string, args?: unknown[]) {
  return client.query(toPgSql(sql), args);
}

async function ensureRepo(client: PoolClient, owner: string, repo: string): Promise<number> {
  await client.query(
    `INSERT INTO repos (owner, repo) VALUES ($1, $2)
     ON CONFLICT(owner, repo) DO NOTHING`,
    [owner, repo],
  );

  const { rows } = await client.query(
    `SELECT id FROM repos WHERE owner = $1 AND repo = $2`,
    [owner, repo],
  );

  if (rows.length === 0) {
    throw new Error(`Failed to ensure repository ${owner}/${repo} in database`);
  }

  return Number(rows[0].id);
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

export async function writeRuns(repo: string, runs: RunRow[], date: string): Promise<void> {
  if (runs.length === 0) return;

  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  try {
    await client.query('BEGIN');

    // Write runs
    for (const batch of chunkArray(runs, RUN_UPSERT_BATCH_SIZE)) {
      for (const run of batch) {
        await client.query(
          `INSERT INTO runs (id, repo_id, name, head_branch, head_sha, status, conclusion, event, created_at, updated_at, html_url, duration_seconds, date, steps_checked_at, workflow_file, workflow_ref, workflow_path, workflow_parse_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, conclusion=excluded.conclusion, event=excluded.event,
             updated_at=excluded.updated_at, html_url=excluded.html_url,
             duration_seconds=excluded.duration_seconds, steps_checked_at=excluded.steps_checked_at,
             workflow_file=excluded.workflow_file, workflow_ref=excluded.workflow_ref,
             workflow_path=excluded.workflow_path, workflow_parse_status=excluded.workflow_parse_status`,
          [
            run.id, repoId, run.name, run.head_branch, run.head_sha ?? null,
            run.status, run.conclusion ?? null, run.event ?? null,
            run.created_at, run.updated_at, run.html_url, run.durationInSeconds,
            date, run.updated_at,
            run.workflowFile ?? null, run.workflowRef ?? null, run.workflowPath ?? null,
            run.workflowParseStatus ?? null,
          ],
        );
      }
    }

    // Write jobs
    const jobRows: {
      id: number; run_id: number; name: string; status: string;
      conclusion: string | null; created_at: string; started_at: string;
      completed_at: string; html_url: string; queue_duration_seconds: number;
      duration_seconds: number; labels_json: string | null; runner_id: number | null;
      runner_name: string | null; runner_group_id: number | null; runner_group_name: string | null;
      resource_model: string | null; resource_count: number | null;
    }[] = [];

    for (const run of runs) {
      if (run.jobs) {
        for (const job of run.jobs) {
          jobRows.push({
            id: job.id, run_id: run.id, name: job.name, status: job.status,
            conclusion: job.conclusion || null, created_at: job.created_at,
            started_at: job.started_at, completed_at: job.completed_at,
            html_url: job.html_url, queue_duration_seconds: job.queueDurationInSeconds,
            duration_seconds: job.durationInSeconds, labels_json: job.labels ? JSON.stringify(job.labels) : null,
            runner_id: job.runner_id ?? null, runner_name: job.runner_name ?? null,
            runner_group_id: job.runner_group_id ?? null, runner_group_name: job.runner_group_name ?? null,
            resource_model: job.resource_model ?? null, resource_count: job.resource_count ?? null,
          });
        }
      }
    }

    for (const batch of chunkArray(jobRows, JOB_UPSERT_BATCH_SIZE)) {
      for (const job of batch) {
        await client.query(
          `INSERT INTO jobs (id, run_id, name, status, conclusion, created_at, started_at, completed_at, html_url, queue_duration_seconds, duration_seconds, labels_json, runner_id, runner_name, runner_group_id, runner_group_name, resource_model, resource_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, conclusion=excluded.conclusion,
             started_at=excluded.started_at, completed_at=excluded.completed_at,
             html_url=excluded.html_url, queue_duration_seconds=excluded.queue_duration_seconds,
             duration_seconds=excluded.duration_seconds, labels_json=excluded.labels_json,
             runner_id=excluded.runner_id, runner_name=excluded.runner_name,
             runner_group_id=excluded.runner_group_id, runner_group_name=excluded.runner_group_name,
             resource_model=excluded.resource_model, resource_count=excluded.resource_count`,
          [
            job.id, job.run_id, job.name, job.status, job.conclusion,
            job.created_at, job.started_at, job.completed_at, job.html_url,
            job.queue_duration_seconds, job.duration_seconds, job.labels_json,
            job.runner_id, job.runner_name, job.runner_group_id, job.runner_group_name,
            job.resource_model, job.resource_count,
          ],
        );
      }
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
      for (const step of batch) {
        await client.query(
          `INSERT INTO steps (job_id, number, name, status, conclusion, started_at, completed_at, duration_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT(job_id, number) DO UPDATE SET
             status=excluded.status, conclusion=excluded.conclusion,
             started_at=excluded.started_at, completed_at=excluded.completed_at,
             duration_seconds=excluded.duration_seconds`,
          [
            step.job_id, step.number, step.name, step.status, step.conclusion,
            step.started_at, step.completed_at, step.duration_seconds,
          ],
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function writeWorkflowAttempts(repo: string, attempts: WorkflowAttemptRow[]): Promise<void> {
  if (attempts.length === 0) return;
  const client = await requireClient(repo);
  await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);
  try {
    await writeWorkflowAttemptsToClient(client, attempts);
  } finally {
    client.release();
  }
}

export async function getExistingRunIds(repo: string): Promise<Set<number>> {
  const client = await getDatabaseClient();
  if (!client) return new Set();

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const { rows } = await client.query(`SELECT id FROM runs WHERE repo_id = $1`, [repoId]);
    return new Set(rows.map((r) => Number(r.id)));
  } finally {
    client.release();
  }
}

export async function getExistingRunIdsWithJobs(repo: string): Promise<Set<number>> {
  const client = await getDatabaseClient();
  if (!client) return new Set();

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const runIds = new Set<number>();
    let lastId = 0;

    while (true) {
      const { rows } = await client.query(
        `SELECT r.id FROM runs r WHERE r.repo_id = $1 AND r.id > $2 AND EXISTS (SELECT 1 FROM jobs j WHERE j.run_id = r.id) ORDER BY r.id LIMIT $3`,
        [repoId, lastId, PAGE_SIZE],
      );

      for (const row of rows) {
        runIds.add(Number(row.id));
      }

      if (rows.length < PAGE_SIZE) break;
      lastId = Number(rows[rows.length - 1].id);
    }

    return runIds;
  } finally {
    client.release();
  }
}

export async function getExistingRunIdsWithSteps(repo: string): Promise<Map<number, string>> {
  const client = await getDatabaseClient();
  if (!client) return new Map();

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const runIds = new Map<number, string>();
    let lastId = 0;

    while (true) {
      const { rows } = await client.query(
        `SELECT r.id, r.updated_at FROM runs r
         WHERE r.repo_id = $1 AND r.id > $2 AND r.steps_checked_at IS NOT NULL
           AND r.steps_checked_at >= r.updated_at
         ORDER BY r.id LIMIT $3`,
        [repoId, lastId, PAGE_SIZE],
      );

      for (const row of rows) {
        runIds.set(Number(row.id), row.updated_at as string);
      }

      if (rows.length < PAGE_SIZE) break;
      lastId = Number(rows[rows.length - 1].id);
    }

    return runIds;
  } finally {
    client.release();
  }
}

export async function readPullRequestResolutionCache(
  repo: string,
  shas: string[],
): Promise<Map<string, PullRequestResolutionCacheRecord>> {
  const client = await getDatabaseClient();
  if (!client || shas.length === 0) return new Map();

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const cached = new Map<string, PullRequestResolutionCacheRecord>();
    const uniqueShas = Array.from(new Set(shas));

    for (const batch of chunkArray(uniqueShas, CACHE_UPSERT_BATCH_SIZE)) {
      const placeholders = pgPlaceholders(batch.length);
      const { rows } = await client.query(
        `SELECT head_sha, pr_number, source, status, error_message
         FROM pr_resolution_cache
         WHERE repo_id = $1 AND head_sha IN (${placeholders})`,
        [repoId, ...batch],
      );

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
  } finally {
    client.release();
  }
}

export async function writePullRequestResolutionCache(
  repo: string,
  entries: PullRequestResolutionCacheEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  try {
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
      const placeholders = pgPlaceholders(batch.length);
      const { rows } = await client.query(
        `SELECT head_sha, pr_number, source, status, error_message
         FROM pr_resolution_cache
         WHERE repo_id = $1 AND head_sha IN (${placeholders})`,
        [repoId, ...batch],
      );

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

    await client.query('BEGIN');
    try {
      for (const batch of chunkArray(rowsToInsert, CACHE_UPSERT_BATCH_SIZE)) {
        for (const r of batch) {
          await client.query(
            `INSERT INTO pr_resolution_cache (repo_id, head_sha, pr_number, source, status, error_message, attempted_at, resolved_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(repo_id, head_sha) DO UPDATE SET
               pr_number=excluded.pr_number, source=excluded.source, status=excluded.status,
               error_message=excluded.error_message, attempted_at=excluded.attempted_at,
               resolved_at=excluded.resolved_at`,
            [
              r.repo_id, r.head_sha, r.pr_number, r.source, r.status,
              r.error_message, r.attempted_at, r.resolved_at,
            ],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function writePrWorkflows(repo: string, prWorkflows: Map<number, number[]>): Promise<void> {
  if (prWorkflows.size === 0) return;

  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  try {
    // Look up pr_metric IDs by pr_number
    const prNumberToId = new Map<number, number>();
    const prNumbers = Array.from(prWorkflows.keys());

    for (const batch of chunkArray(prNumbers, PR_METRIC_UPSERT_BATCH_SIZE)) {
      const placeholders = pgPlaceholders(batch.length);
      const { rows } = await client.query(
        `SELECT id, pr_number FROM pr_metrics WHERE repo_id = $1 AND pr_number IN (${placeholders})`,
        [repoId, ...batch],
      );

      for (const row of rows) {
        prNumberToId.set(row.pr_number as number, Number(row.id));
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

    await client.query('BEGIN');
    try {
      for (const batch of chunkArray(workflowRows, PR_WORKFLOW_UPSERT_BATCH_SIZE)) {
        for (const r of batch) {
          await client.query(
            `INSERT INTO pr_workflows (pr_metric_id, run_id) VALUES ($1, $2)
             ON CONFLICT(pr_metric_id, run_id) DO NOTHING`,
            [r.pr_metric_id, r.run_id],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function writePrWorkflowAttempts(
  repo: string,
  prWorkflowAttempts: Map<number, Array<{ runId: number; runAttempt: number }>>,
): Promise<void> {
  if (prWorkflowAttempts.size === 0) return;
  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);
  try {
    await writePrWorkflowAttemptsToClient(client, repoId, prWorkflowAttempts);
  } finally {
    client.release();
  }
}

export async function writePrMetrics(repo: string, prs: PrMetricsSummary[]): Promise<void> {
  if (prs.length === 0) return;

  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  try {
    await client.query('BEGIN');
    try {
      for (const batch of chunkArray(prs, PR_METRIC_UPSERT_BATCH_SIZE)) {
        for (const pr of batch) {
          await client.query(
            `INSERT INTO pr_metrics (repo_id, pr_number, title, branch, author, state, html_url, created_at, ci_started_at, ci_completed_at, merged_at, partial_ci_history, time_to_ci_start_seconds, ci_duration_seconds, time_to_merge_seconds, merge_lead_time_seconds, workflow_count, successful_workflow_count, conclusion)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
            [
              repoId, pr.number, pr.title, pr.branch, pr.author || null, pr.state,
              pr.html_url, pr.created_at, pr.ci_started_at || null, pr.ci_completed_at || null,
              pr.merged_at || null, pr.partialCiHistory ? 1 : 0, pr.timeToCiStartInSeconds || null,
              pr.ciDurationInSeconds || null, pr.timeToMergeInSeconds || null, pr.mergeLeadTimeInSeconds || null,
              pr.workflowCount, pr.successfulWorkflowCount, pr.conclusion || null,
            ],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function readCollectionState(repo: string): Promise<CollectionState | null> {
  const client = await getDatabaseClient();
  if (!client) return null;

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const { rows } = await client.query(
      `SELECT * FROM collection_state WHERE repo_id = $1`,
      [repoId],
    );

    if (rows.length === 0) return null;

    const data = rows[0];
    return {
      backfillCursor: ((data.backfill_cursor as string) || '').slice(0, 10) || null,
      historyComplete: Boolean(data.history_complete),
      latestDate: ((data.latest_date as string) || '').slice(0, 10) || null,
      retentionDays: Number(data.retention_days ?? 90),
      lastUpdated: (data.last_updated as string) || null,
    };
  } finally {
    client.release();
  }
}

export async function writeCollectionState(repo: string, state: CollectionState): Promise<void> {
  const client = await requireClient(repo);
  const repoId = await ensureRepo(client, repo.split('/')[0], repo.split('/')[1]);

  try {
    await client.query(
      `INSERT INTO collection_state (repo_id, backfill_cursor, history_complete, latest_date, retention_days, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(repo_id) DO UPDATE SET
         backfill_cursor=excluded.backfill_cursor,
         history_complete=excluded.history_complete,
         latest_date=excluded.latest_date,
         retention_days=excluded.retention_days,
         last_updated=excluded.last_updated`,
      [
        repoId,
        state.backfillCursor,
        state.historyComplete ? 1 : 0,
        state.latestDate,
        state.retentionDays,
        state.lastUpdated ?? new Date().toISOString(),
      ],
    );
  } finally {
    client.release();
  }
}

export async function getCollectedDates(repo: string): Promise<string[]> {
  const client = await getDatabaseClient();
  if (!client) return [];

  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);

    const { rows } = await client.query(
      `SELECT DISTINCT date FROM runs WHERE repo_id = $1 ORDER BY date DESC`,
      [repoId],
    );

    return rows.map((r) => r.date as string);
  } finally {
    client.release();
  }
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
  const client = await getDatabaseClient();
  if (!client) return null;

  try {
    const parts = repo.split('/');
    if (parts.length !== 2) {
      console.error(`Invalid repo format for freshness check: ${repo}. Expected owner/repo`);
      return null;
    }

    const repoId = await ensureRepo(client, parts[0], parts[1]);

    const prRelatedEvents = ['pull_request', 'pull_request_target', 'pull_request_review', 'push'];
    const eventPlaceholders = pgPlaceholders(prRelatedEvents.length);

    const [runsResult, metricsResult] = await Promise.all([
      client.query(
        `SELECT created_at FROM runs WHERE repo_id = $1 AND event IN (${eventPlaceholders})
         ORDER BY created_at DESC LIMIT 1`,
        [repoId, ...prRelatedEvents],
      ),
      client.query(
        `SELECT ci_completed_at FROM pr_metrics WHERE repo_id = $1
         AND ci_completed_at IS NOT NULL ORDER BY ci_completed_at DESC LIMIT 1`,
        [repoId],
      ),
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
  } finally {
    client.release();
  }
}
