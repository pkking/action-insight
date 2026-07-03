/**
 * Shared workflow-attempt write helpers used by both the Turso and SQLite
 * storage modules. The two backends differ only in how they obtain a client
 * (and repo id); the batched INSERT/upsert logic is identical, so it lives
 * here once. See ADR-005.
 */

import type { Client, InValue } from '@libsql/client';
import type { WorkflowAttemptRow } from './workflow-attempts.ts';

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

const WORKFLOW_ATTEMPT_UPSERT_BATCH_SIZE = Number(process.env.WORKFLOW_ATTEMPT_UPSERT_BATCH_SIZE) || 200;
const WORKFLOW_JOB_UPSERT_BATCH_SIZE = Number(process.env.WORKFLOW_JOB_UPSERT_BATCH_SIZE) || 500;
const WORKFLOW_STEP_UPSERT_BATCH_SIZE = Number(process.env.WORKFLOW_STEP_UPSERT_BATCH_SIZE) || 500;
const PR_METRIC_UPSERT_BATCH_SIZE = Number(process.env.PR_METRIC_UPSERT_BATCH_SIZE) || 100;
const PR_WORKFLOW_UPSERT_BATCH_SIZE = Number(process.env.PR_WORKFLOW_UPSERT_BATCH_SIZE) || 500;

/** Upsert workflow attempts + their jobs + eligible steps in one transaction. */
export async function writeWorkflowAttemptsToClient(client: Client, attempts: WorkflowAttemptRow[]): Promise<void> {
  if (attempts.length === 0) return;

  const tx = await client.transaction('write');
  try {
    for (const batch of chunkArray(attempts, WORKFLOW_ATTEMPT_UPSERT_BATCH_SIZE)) {
      await tx.batch(batch.map((attempt) => ({
        sql: `INSERT INTO workflow_attempts (
                run_id, run_attempt, status, conclusion, created_at, run_started_at,
                completed_at, updated_at, queue_duration_seconds, runtime_seconds,
                total_duration_seconds, tracked, workflow_file, workflow_ref, match_kind,
                jobs_fetched_at, steps_eligibility_checked_at, steps_collected_at, step_policy_hash
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, run_attempt) DO UPDATE SET
                status=excluded.status, conclusion=excluded.conclusion, created_at=excluded.created_at,
                run_started_at=excluded.run_started_at, completed_at=excluded.completed_at,
                updated_at=excluded.updated_at, queue_duration_seconds=excluded.queue_duration_seconds,
                runtime_seconds=excluded.runtime_seconds, total_duration_seconds=excluded.total_duration_seconds,
                tracked=excluded.tracked, workflow_file=excluded.workflow_file,
                workflow_ref=excluded.workflow_ref, match_kind=excluded.match_kind,
                jobs_fetched_at=COALESCE(excluded.jobs_fetched_at, workflow_attempts.jobs_fetched_at),
                steps_eligibility_checked_at=COALESCE(excluded.steps_eligibility_checked_at, workflow_attempts.steps_eligibility_checked_at),
                steps_collected_at=COALESCE(excluded.steps_collected_at, workflow_attempts.steps_collected_at),
                step_policy_hash=excluded.step_policy_hash`,
        args: [
          attempt.run_id, attempt.run_attempt, attempt.status, attempt.conclusion,
          attempt.created_at, attempt.run_started_at, attempt.completed_at, attempt.updated_at,
          attempt.queue_duration_seconds, attempt.runtime_seconds, attempt.total_duration_seconds,
          attempt.tracked ? 1 : 0, attempt.workflow_file, attempt.workflow_ref, attempt.match_kind,
          attempt.jobs_fetched_at, attempt.steps_eligibility_checked_at, attempt.steps_collected_at,
          attempt.step_policy_hash,
        ] as InValue[],
      })));
    }

    const jobRows = attempts.flatMap((attempt) => attempt.jobs);
    for (const batch of chunkArray(jobRows, WORKFLOW_JOB_UPSERT_BATCH_SIZE)) {
      await tx.batch(batch.map((job) => ({
        sql: `INSERT INTO workflow_jobs (
                run_id, run_attempt, job_id, name, status, conclusion, created_at,
                started_at, completed_at, html_url, queue_duration_seconds,
                runtime_seconds, total_duration_seconds, duration_seconds
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, run_attempt, job_id) DO UPDATE SET
                name=excluded.name, status=excluded.status, conclusion=excluded.conclusion,
                created_at=excluded.created_at, started_at=excluded.started_at,
                completed_at=excluded.completed_at, html_url=excluded.html_url,
                queue_duration_seconds=excluded.queue_duration_seconds,
                runtime_seconds=excluded.runtime_seconds,
                total_duration_seconds=excluded.total_duration_seconds,
                duration_seconds=excluded.duration_seconds`,
        args: [
          job.run_id, job.run_attempt, job.job_id, job.name, job.status, job.conclusion,
          job.created_at, job.started_at, job.completed_at, job.html_url,
          job.queue_duration_seconds, job.runtime_seconds, job.total_duration_seconds,
          job.runtime_seconds,
        ] as InValue[],
      })));
    }

    const stepRows = jobRows.flatMap((job) =>
      (job.steps ?? []).map((step) => ({
        run_id: job.run_id,
        run_attempt: job.run_attempt,
        job_id: job.job_id,
        step,
      }))
    );
    for (const batch of chunkArray(stepRows, WORKFLOW_STEP_UPSERT_BATCH_SIZE)) {
      await tx.batch(batch.map(({ run_id, run_attempt, job_id, step }) => ({
        sql: `INSERT INTO workflow_steps (
                run_id, run_attempt, job_id, step_number, name, status, conclusion,
                started_at, completed_at, duration_seconds
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, run_attempt, job_id, step_number) DO UPDATE SET
                name=excluded.name, status=excluded.status, conclusion=excluded.conclusion,
                started_at=excluded.started_at, completed_at=excluded.completed_at,
                duration_seconds=excluded.duration_seconds`,
        args: [
          run_id, run_attempt, job_id, step.number, step.name, step.status,
          step.conclusion || null, step.started_at ?? null, step.completed_at ?? null,
          step.duration_seconds ?? null,
        ] as InValue[],
      })));
    }

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

/** Upsert PR -> workflow-attempt links for one repo. */
export async function writePrWorkflowAttemptsToClient(
  client: Client,
  repoId: number,
  prWorkflowAttempts: Map<number, Array<{ runId: number; runAttempt: number }>>,
): Promise<void> {
  if (prWorkflowAttempts.size === 0) return;

  const prNumberToId = new Map<number, number>();
  const prNumbers = Array.from(prWorkflowAttempts.keys());
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

  // pr_workflow_attempts FKs workflow_attempts(run_id, run_attempt); keep only
  // attempts that exist so pre-ADR-005 / uncollected runs don't violate the
  // constraint (FK enforcement is on for both Turso and SQLite).
  const runIds = Array.from(new Set(
    Array.from(prWorkflowAttempts.values()).flatMap((attempts) => attempts.map((a) => a.runId)),
  ));
  const existingAttempts = new Set<string>();
  for (const batch of chunkArray(runIds, PR_METRIC_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => '?').join(',');
    const { rows: attemptRows } = await client.execute({
      sql: `SELECT run_id, run_attempt FROM workflow_attempts WHERE run_id IN (${placeholders})`,
      args: batch,
    });
    for (const row of attemptRows) {
      existingAttempts.add(`${Number(row.run_id)}:${Number(row.run_attempt)}`);
    }
  }

  const rows: { pr_metric_id: number; run_id: number; run_attempt: number }[] = [];
  for (const [prNumber, attempts] of prWorkflowAttempts.entries()) {
    const prMetricId = prNumberToId.get(prNumber);
    if (!prMetricId) continue;
    for (const attempt of attempts) {
      if (existingAttempts.has(`${attempt.runId}:${attempt.runAttempt}`)) {
        rows.push({ pr_metric_id: prMetricId, run_id: attempt.runId, run_attempt: attempt.runAttempt });
      }
    }
  }
  if (rows.length === 0) return;

  const tx = await client.transaction('write');
  try {
    for (const batch of chunkArray(rows, PR_WORKFLOW_UPSERT_BATCH_SIZE)) {
      await tx.batch(batch.map((row) => ({
        sql: `INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt)
              VALUES (?, ?, ?)
              ON CONFLICT(pr_metric_id, run_id, run_attempt) DO NOTHING`,
        args: [row.pr_metric_id, row.run_id, row.run_attempt] as InValue[],
      })));
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}
