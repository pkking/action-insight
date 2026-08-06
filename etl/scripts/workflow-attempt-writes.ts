/**
 * Shared workflow-attempt write helpers. Batched INSERT/upsert logic for
 * workflow_attempts, workflow_jobs, workflow_steps, and pr_workflow_attempts.
 * See ADR-005.
 */

import type { PoolClient } from 'pg';
import type { WorkflowAttemptRow } from './workflow-attempts.ts';
import { toPgSql, pgPlaceholders } from './pg-utils.ts';

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
export async function writeWorkflowAttemptsToClient(client: PoolClient, attempts: WorkflowAttemptRow[]): Promise<void> {
  if (attempts.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const batch of chunkArray(attempts, WORKFLOW_ATTEMPT_UPSERT_BATCH_SIZE)) {
      for (const attempt of batch) {
        await client.query(
          toPgSql(`INSERT INTO workflow_attempts (
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
                step_policy_hash=excluded.step_policy_hash`),
          [
            attempt.run_id, attempt.run_attempt, attempt.status, attempt.conclusion,
            attempt.created_at, attempt.run_started_at, attempt.completed_at, attempt.updated_at,
            attempt.queue_duration_seconds, attempt.runtime_seconds, attempt.total_duration_seconds,
            attempt.tracked ? 1 : 0, attempt.workflow_file, attempt.workflow_ref, attempt.match_kind,
            attempt.jobs_fetched_at, attempt.steps_eligibility_checked_at, attempt.steps_collected_at,
            attempt.step_policy_hash,
          ],
        );
      }
    }

    const jobRows = attempts.flatMap((attempt) => attempt.jobs);
    for (const batch of chunkArray(jobRows, WORKFLOW_JOB_UPSERT_BATCH_SIZE)) {
      for (const job of batch) {
        await client.query(
          toPgSql(`INSERT INTO workflow_jobs (
                run_id, run_attempt, job_id, name, status, conclusion, created_at,
                started_at, completed_at, html_url, queue_duration_seconds,
                runtime_seconds, total_duration_seconds, duration_seconds, labels_json,
                runner_id, runner_name, runner_group_id, runner_group_name,
                resource_model, resource_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, run_attempt, job_id) DO UPDATE SET
                name=excluded.name, status=excluded.status, conclusion=excluded.conclusion,
                created_at=excluded.created_at, started_at=excluded.started_at,
                completed_at=excluded.completed_at, html_url=excluded.html_url,
                queue_duration_seconds=excluded.queue_duration_seconds,
                runtime_seconds=excluded.runtime_seconds,
                total_duration_seconds=excluded.total_duration_seconds,
                duration_seconds=excluded.duration_seconds, labels_json=excluded.labels_json,
                runner_id=excluded.runner_id, runner_name=excluded.runner_name,
                runner_group_id=excluded.runner_group_id, runner_group_name=excluded.runner_group_name,
                resource_model=excluded.resource_model, resource_count=excluded.resource_count`),
          [
            job.run_id, job.run_attempt, job.job_id, job.name, job.status, job.conclusion,
            job.created_at, job.started_at, job.completed_at, job.html_url,
            job.queue_duration_seconds, job.runtime_seconds, job.total_duration_seconds,
            job.runtime_seconds, job.labels ? JSON.stringify(job.labels) : null,
            job.runner_id ?? null, job.runner_name ?? null, job.runner_group_id ?? null,
            job.runner_group_name ?? null, job.resource_model ?? null, job.resource_count ?? null,
          ],
        );
      }
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
      for (const { run_id, run_attempt, job_id, step } of batch) {
        await client.query(
          toPgSql(`INSERT INTO workflow_steps (
                run_id, run_attempt, job_id, step_number, name, status, conclusion,
                started_at, completed_at, duration_seconds
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, run_attempt, job_id, step_number) DO UPDATE SET
                name=excluded.name, status=excluded.status, conclusion=excluded.conclusion,
                started_at=excluded.started_at, completed_at=excluded.completed_at,
                duration_seconds=excluded.duration_seconds`),
          [
            run_id, run_attempt, job_id, step.number, step.name, step.status,
            step.conclusion || null, step.started_at ?? null, step.completed_at ?? null,
            step.duration_seconds ?? null,
          ],
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/** Upsert PR -> workflow-attempt links for one repo. */
export async function writePrWorkflowAttemptsToClient(
  client: PoolClient,
  repoId: number,
  prWorkflowAttempts: Map<number, Array<{ runId: number; runAttempt: number }>>,
): Promise<void> {
  if (prWorkflowAttempts.size === 0) return;

  const prNumberToId = new Map<number, number>();
  const prNumbers = Array.from(prWorkflowAttempts.keys());
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

  // Keep only attempts that exist so FK constraints aren't violated.
  const runIds = Array.from(new Set(
    Array.from(prWorkflowAttempts.values()).flatMap((attempts) => attempts.map((a) => a.runId)),
  ));
  const existingAttempts = new Set<string>();
  for (const batch of chunkArray(runIds, PR_METRIC_UPSERT_BATCH_SIZE)) {
    const placeholders = pgPlaceholders(batch.length);
    const { rows: attemptRows } = await client.query(
      `SELECT run_id, run_attempt FROM workflow_attempts WHERE run_id IN (${placeholders})`,
      batch,
    );
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

  await client.query('BEGIN');
  try {
    for (const batch of chunkArray(rows, PR_WORKFLOW_UPSERT_BATCH_SIZE)) {
      for (const row of batch) {
        await client.query(
          toPgSql(`INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt)
              VALUES (?, ?, ?)
              ON CONFLICT(pr_metric_id, run_id, run_attempt) DO NOTHING`),
          [row.pr_metric_id, row.run_id, row.run_attempt],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
