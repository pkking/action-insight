import { getDatabaseClient, getRepoId } from './db';
import { toPgSql, pgPlaceholders } from './pg-utils';
import { mergeAttemptRows } from './ci-cycles';
import { computePullRequestAttemptMetrics } from './pr-metrics';
import type { PullRequestDetailFile, PullRequestIndexFile, PullRequestMetricsSummary, Run } from './types';

function parseLabelsJson(value: unknown): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function mapPrSummary(row: Record<string, unknown>): PullRequestMetricsSummary {
  return {
    number: Number(row.pr_number),
    title: row.title as string,
    branch: row.branch as string,
    author: (row.author as string) || '',
    state: row.state as string,
    html_url: row.html_url as string,
    created_at: row.created_at as string,
    ci_started_at: (row.ci_started_at as string) || undefined,
    ci_completed_at: (row.ci_completed_at as string) || undefined,
    merged_at: (row.merged_at as string) || undefined,
    partialCiHistory: Boolean(row.partial_ci_history),
    timeToCiStartInSeconds: row.time_to_ci_start_seconds ? Number(row.time_to_ci_start_seconds) : undefined,
    ciDurationInSeconds: row.ci_duration_seconds ? Number(row.ci_duration_seconds) : undefined,
    timeToMergeInSeconds: row.time_to_merge_seconds ? Number(row.time_to_merge_seconds) : undefined,
    mergeLeadTimeInSeconds: row.merge_lead_time_seconds ? Number(row.merge_lead_time_seconds) : undefined,
    workflowCount: Number(row.workflow_count),
    successfulWorkflowCount: Number(row.successful_workflow_count),
    conclusion: (row.conclusion as string) || '',
  };
}

function mapRunRow(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    name: row.name as string,
    head_branch: row.head_branch as string,
    head_sha: row.head_sha as string | undefined,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    event: row.event as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    html_url: row.html_url as string,
    durationInSeconds: Number(row.duration_seconds),
    pull_requests: [],
    jobs: [],
  };
}

function timingEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const evidence = value as Record<string, unknown>;
  return evidence.version === 1 ? evidence : undefined;
}

function evidenceDuration(evidence: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = evidence?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function mapAttemptRunRow(row: Record<string, unknown>): Run {
  const evidence = timingEvidence(row.timing_evidence);
  const runtime = evidenceDuration(evidence, 'runtime_seconds');
  const evidenceTrigger = validTimestamp(evidence?.trigger_at);
  const storedTrigger = validTimestamp(row.attempt_created_at);
  const triggerAt = Number(row.run_attempt) === 1 && evidenceTrigger && storedTrigger
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(evidenceTrigger)
    && Date.parse(evidenceTrigger) === Date.parse(storedTrigger) ? evidenceTrigger : undefined;
  // The source marker alone does not bind wa.completed_at: the current ETL
  // writes run.updated_at there, which can differ from raw completed_at.
  const evidenceCompletion = validTimestamp(evidence?.completed_at);
  const storedCompletion = validTimestamp(row.completed_at);
  const completedAt = evidence?.completion_source === 'github_run.completed_at' &&
    evidenceCompletion && storedCompletion && Date.parse(evidenceCompletion) === Date.parse(storedCompletion)
    ? storedCompletion : undefined;
  return {
    ...mapRunRow(row),
    runAttempt: Number(row.run_attempt),
    status: (row.attempt_status as string) || (row.status as string),
    conclusion: (row.attempt_conclusion as string) || (row.conclusion as string) || '',
    // CI cycles group by the parent push creation, not the attempt trigger.
    created_at: row.created_at as string,
    attemptTiming: { triggerAt, completedAt, runtimeSeconds: runtime },
    run_started_at: row.run_started_at as string | undefined,
    updated_at: (row.completed_at as string) || (row.attempt_updated_at as string) || '',
    parentCreatedAt: row.created_at as string,
    parentUpdatedAt: row.updated_at as string,
    durationInSeconds: evidenceDuration(evidence, 'total_duration_seconds') as number,
    queueDurationInSeconds: evidenceDuration(evidence, 'queue_duration_seconds'),
    runtimeInSeconds: runtime,
    workflowFile: (row.attempt_workflow_file ?? row.workflow_file) as string | undefined,
    workflowRef: (row.attempt_workflow_ref ?? row.workflow_ref) as string | undefined,
    workflowMatchKind: row.match_kind as Run['workflowMatchKind'],
    stepPolicyHash: row.step_policy_hash as string | undefined,
    tracked: Boolean(row.tracked),
    jobs: [],
  };
}

export async function fetchPullRequestIndex(owner: string, repo: string): Promise<PullRequestIndexFile> {
  const repoId = await getRepoId(owner, repo);
  const client = await getDatabaseClient();
  try {
  const { rows } = await client.query(toPgSql(`SELECT * FROM pr_metrics WHERE repo_id = ? ORDER BY created_at DESC`), [repoId]);

  if (rows.length === 0) {
    return {
      repo: `${owner}/${repo}`,
      generated_at: new Date().toISOString(),
      prs: [],
      missingPrArtifact: true,
    };
  }

  return {
    repo: `${owner}/${repo}`,
    generated_at: new Date().toISOString(),
    prs: rows.map((r) => mapPrSummary(r as Record<string, unknown>)),
  };
  } finally {
    client.release();
  }
}

export async function fetchPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetailFile> {
  const repoId = await getRepoId(owner, repo);
  const client = await getDatabaseClient();
  try {
  // Fetch PR metrics
  const { rows: prRows } = await client.query(toPgSql(`SELECT * FROM pr_metrics WHERE repo_id = ? AND pr_number = ?`), [repoId, number]);

  if (prRows.length === 0) {
    throw new Error(`PR #${number} not found for ${owner}/${repo}`);
  }

  const prData = prRows[0] as Record<string, unknown>;

  // Fetch PR workflow attempts first; fall back to legacy run-level links.
  const { rows: attemptRows } = await client.query(
    toPgSql(`SELECT run_id, run_attempt FROM pr_workflow_attempts WHERE pr_metric_id = ?`),
    [prData.id as number],
  ).catch(() => ({ rows: [] }));

  // ADR-020: branch-matched enrichment. Runs on the PR's branch (pull-request
  // events only, tracked attempts) bounded by the PR lifecycle window —
  // PR created_at → merged_at (or now). Recovers cycles missed by partial
  // SHA→PR resolution; linked rows always win and branch-matched runs are
  // tagged for UI disclosure.
  const prBranch = (prData.branch as string) || '';
  const prCreatedAt = (prData.created_at as string) || '';
  const branchUpperBound =
    (prData.merged_at as string) || new Date().toISOString();
  let branchMatchedRows: Array<{ run_id: number; run_attempt: number }> = [];
  if (prBranch && prCreatedAt) {
    const { rows: branchRows } = await client
      .query(
        toPgSql(
          `SELECT wa.run_id, wa.run_attempt
             FROM workflow_attempts wa
             JOIN runs r ON r.id = wa.run_id
            WHERE r.repo_id = ?
              AND r.head_branch = ?
              AND r.event IN ('pull_request', 'pull_request_target', 'pull_request_review')
              AND wa.tracked = 1
              AND r.created_at >= ?
              AND r.created_at <= ?
            LIMIT 500`,
        ),
        [repoId, prBranch, prCreatedAt, branchUpperBound],
      )
      .catch(() => ({ rows: [] }));
    branchMatchedRows = branchRows as Array<{ run_id: number; run_attempt: number }>;
  }

  const mergedAttemptRows = mergeAttemptRows(
    attemptRows as Array<{ run_id: number; run_attempt: number }>,
    branchMatchedRows,
  );
  const branchMatchedKeys = new Set(
    mergedAttemptRows
      .filter((row) => row.branchMatched)
      .map((row) => `${row.run_id}:${row.run_attempt}`),
  );

  let workflows: Run[] = [];

  if (mergedAttemptRows.length > 0) {
    // Chunk to stay below SQLite's 999-variable limit (100 attempts = 200 vars);
    // merge and sort in TS since per-chunk ORDER BY isn't globally ordered.
    const runRows: Record<string, unknown>[] = [];
    const chunkSize = 100;
    for (let i = 0; i < mergedAttemptRows.length; i += chunkSize) {
      const chunk = mergedAttemptRows.slice(i, i + chunkSize);
      const clauses = chunk.map((_, idx) => `(wa.run_id = $${idx * 2 + 1} AND wa.run_attempt = $${idx * 2 + 2})`).join(' OR ');
      const { rows: chunkRows } = await client.query(
        toPgSql(`SELECT r.*, wa.run_attempt, wa.status AS attempt_status,
                     wa.conclusion AS attempt_conclusion, wa.created_at AS attempt_created_at,
                     wa.run_started_at, wa.completed_at, wa.updated_at AS attempt_updated_at,
                     to_jsonb(wa)->'timing_evidence' AS timing_evidence,
                     wa.tracked, wa.workflow_file AS attempt_workflow_file, wa.workflow_ref AS attempt_workflow_ref, wa.match_kind, wa.step_policy_hash,
                     wj.job_id, wj.name AS job_name, wj.status AS job_status,
                     wj.conclusion AS job_conclusion, wj.created_at AS job_created_at,
                     wj.started_at AS job_started_at, wj.completed_at AS job_completed_at,
                     wj.html_url AS job_html_url,
                     to_jsonb(wj)->'timing_evidence' AS job_timing_evidence,
                     wj.queue_duration_seconds AS job_queue_duration_seconds,
                     wj.runtime_seconds AS job_runtime_seconds,
                     wj.total_duration_seconds AS job_total_duration_seconds,
                     wj.labels_json AS job_labels_json,
                     wj.runner_id AS job_runner_id, wj.runner_name AS job_runner_name,
                     wj.runner_group_id AS job_runner_group_id, wj.runner_group_name AS job_runner_group_name,
                     wj.resource_model AS job_resource_model,
                     wj.resource_count AS job_resource_count
              FROM workflow_attempts wa
              JOIN runs r ON r.id = wa.run_id
              LEFT JOIN workflow_jobs wj ON wj.run_id = wa.run_id AND wj.run_attempt = wa.run_attempt
              WHERE ${clauses}`),
        chunk.flatMap((w) => [w.run_id as number, w.run_attempt as number]),
      );
      runRows.push(...chunkRows);
    }

    const runMap = new Map<string, Run>();
    for (const row of runRows) {
      const key = `${Number(row.id)}:${Number(row.run_attempt)}`;
      if (!runMap.has(key)) {
        const mapped = mapAttemptRunRow(row);
        if (branchMatchedKeys.has(key)) mapped.branchMatched = true;
        runMap.set(key, mapped);
      }
      if (row.job_id != null) {
        const run = runMap.get(key)!;
        const jobEvidence = timingEvidence(row.job_timing_evidence);
        run.jobs!.push({
          id: Number(row.job_id),
          runAttempt: Number(row.run_attempt),
          name: row.job_name as string,
          status: row.job_status as string,
          conclusion: (row.job_conclusion as string) || '',
          created_at: (row.job_created_at as string) || '',
          started_at: (row.job_started_at as string) || '',
          completed_at: (row.job_completed_at as string) || '',
          html_url: row.job_html_url as string,
          // Job's shared type requires numbers, but missing evidence is unknown.
          queueDurationInSeconds: evidenceDuration(jobEvidence, 'queue_duration_seconds') as number,
          durationInSeconds: evidenceDuration(jobEvidence, 'runtime_seconds') as number,
          // Legacy runtime remains the input to PR card-hours accounting.
          runtimeInSeconds: row.job_runtime_seconds == null ? undefined : Number(row.job_runtime_seconds),
          totalDurationInSeconds: evidenceDuration(jobEvidence, 'total_duration_seconds'),
          labels: parseLabelsJson(row.job_labels_json),
          runner_id: row.job_runner_id == null ? undefined : Number(row.job_runner_id),
          runner_name: (row.job_runner_name as string) || undefined,
          runner_group_id: row.job_runner_group_id == null ? undefined : Number(row.job_runner_group_id),
          runner_group_name: (row.job_runner_group_name as string) || undefined,
          resource_model: (row.job_resource_model as string) || undefined,
          resource_count: row.job_resource_count == null ? undefined : Number(row.job_resource_count),
        });
      }
    }

    const jobKeys = Array.from(runMap.values()).flatMap((run) =>
      (run.jobs ?? []).map((job) => ({
        runId: run.id,
        runAttempt: run.runAttempt ?? 1,
        jobId: job.id,
      })),
    );
    const stepsByJob = new Map<string, Array<Record<string, unknown>>>();
    const stepChunkSize = 100;
    for (let i = 0; i < jobKeys.length; i += stepChunkSize) {
      const chunk = jobKeys.slice(i, i + stepChunkSize);
      const clauses = chunk.map((_, idx) => `(run_id = $${idx * 3 + 1} AND run_attempt = $${idx * 3 + 2} AND job_id = $${idx * 3 + 3})`).join(' OR ');
      const { rows: stepRows } = await client.query(
        toPgSql(`SELECT run_id, run_attempt, job_id, step_number, name, status, conclusion,
                     started_at, completed_at, duration_seconds
              FROM workflow_steps
              WHERE ${clauses}
              ORDER BY run_id, run_attempt, job_id, step_number`),
        chunk.flatMap((job) => [job.runId, job.runAttempt, job.jobId]),
      ).catch(() => ({ rows: [] }));

      for (const row of stepRows) {
        const key = `${Number(row.run_id)}:${Number(row.run_attempt)}:${Number(row.job_id)}`;
        if (!stepsByJob.has(key)) stepsByJob.set(key, []);
        stepsByJob.get(key)!.push(row as Record<string, unknown>);
      }
    }

    for (const run of runMap.values()) {
      for (const job of run.jobs ?? []) {
        const steps = stepsByJob.get(`${run.id}:${run.runAttempt ?? 1}:${job.id}`) ?? [];
        if (steps.length > 0) {
          job.steps = steps.map((row) => ({
            name: row.name as string,
            status: (row.status as string) || 'unknown',
            conclusion: (row.conclusion as string) || 'unknown',
            started_at: (row.started_at as string) || undefined,
            completed_at: (row.completed_at as string) || undefined,
            number: Number(row.step_number),
            duration_seconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds),
          }));
        }
      }
    }

    workflows = Array.from(runMap.values()).sort((a, b) => {
      const timeA = Date.parse(a.created_at);
      const timeB = Date.parse(b.created_at);
      if (timeA !== timeB) return timeB - timeA;
      if (a.id !== b.id) return b.id - a.id;
      return (b.runAttempt ?? 1) - (a.runAttempt ?? 1);
    });
  } else {
    const { rows: workflowRows } = await client.query(toPgSql(`SELECT run_id FROM pr_workflows WHERE pr_metric_id = ?`), [prData.id as number]);

    if (workflowRows.length > 0) {
    const runIds = workflowRows.map((w) => w.run_id as number);
    const placeholders = pgPlaceholders(runIds.length);

    // Fetch runs with jobs via JOIN
    const { rows: runRows } = await client.query(
      toPgSql(`SELECT r.*, j.id AS job_id, j.name AS job_name, j.status AS job_status,
                   j.conclusion AS job_conclusion, j.created_at AS job_created_at,
                   j.started_at AS job_started_at, j.completed_at AS job_completed_at,
                   j.html_url AS job_html_url,
                   j.queue_duration_seconds, j.duration_seconds AS job_duration_seconds,
                   j.labels_json AS job_labels_json,
                   j.runner_id AS job_runner_id, j.runner_name AS job_runner_name,
                   j.runner_group_id AS job_runner_group_id, j.runner_group_name AS job_runner_group_name,
                   j.resource_model AS job_resource_model,
                   j.resource_count AS job_resource_count
            FROM runs r
            LEFT JOIN jobs j ON j.run_id = r.id
            WHERE r.id IN (${placeholders})
            ORDER BY r.created_at DESC`),
      runIds,
    );

    // Group by run
    const runMap = new Map<number, Run>();
    for (const row of runRows) {
      const runId = Number(row.id);
      if (!runMap.has(runId)) {
        runMap.set(runId, mapRunRow(row as Record<string, unknown>));
      }
      if (row.job_id != null) {
        const run = runMap.get(runId)!;
        run.jobs!.push({
          id: Number(row.job_id),
          name: row.job_name as string,
          status: row.job_status as string,
          conclusion: (row.job_conclusion as string) || '',
          created_at: row.job_created_at as string,
          started_at: row.job_started_at as string,
          completed_at: row.job_completed_at as string,
          html_url: row.job_html_url as string,
          queueDurationInSeconds: Number(row.queue_duration_seconds),
          durationInSeconds: Number(row.job_duration_seconds),
          labels: parseLabelsJson(row.job_labels_json),
          runner_id: row.job_runner_id == null ? undefined : Number(row.job_runner_id),
          runner_name: (row.job_runner_name as string) || undefined,
          runner_group_id: row.job_runner_group_id == null ? undefined : Number(row.job_runner_group_id),
          runner_group_name: (row.job_runner_group_name as string) || undefined,
          resource_model: (row.job_resource_model as string) || undefined,
          resource_count: row.job_resource_count == null ? undefined : Number(row.job_resource_count),
        });
      }
    }

    workflows = Array.from(runMap.values());
    }
  }

  const summary = mapPrSummary(prData);
  const attemptMetrics = computePullRequestAttemptMetrics(workflows);

  return {
    repo: `${owner}/${repo}`,
    generated_at: new Date().toISOString(),
    pr: {
      ...summary,
      currentCiConclusion: attemptMetrics.currentCiConclusion,
      attemptSuccessRate: attemptMetrics.attemptSuccessRate,
      workflows,
    },
  };
  } finally {
    client.release();
  }
}

type RepoDescriptor = {
  owner: string;
  repo: string;
  key: string;
};

export async function fetchPullRequestIndexes(repos: RepoDescriptor[]): Promise<{
  indexesByRepoKey: Record<string, PullRequestIndexFile>;
  failedRepoKeys: string[];
}> {
  const results = await Promise.allSettled(
    repos.map(async (repo) => ({
      key: repo.key,
      index: await fetchPullRequestIndex(repo.owner, repo.repo),
    }))
  );

  const indexesByRepoKey: Record<string, PullRequestIndexFile> = {};
  const failedRepoKeys: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      indexesByRepoKey[result.value.key] = result.value.index;
      continue;
    }

    failedRepoKeys.push(repos[index].key);
  }

  return {
    indexesByRepoKey,
    failedRepoKeys,
  };
}
