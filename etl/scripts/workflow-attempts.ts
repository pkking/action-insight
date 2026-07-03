import type { PullRequestRef, Run, Step } from '../../src/lib/types.ts';
import type { ReposConfig, RepoConfigEntry } from './repos-config.ts';
import { resolveWorkflowMatch, stepPolicyHash, type WorkflowMatchKind } from './workflow-match.ts';
import { parseWorkflowPath, type WorkflowParseStatus } from './workflow-path.ts';

export interface WorkflowAttemptJobRow {
  run_id: number;
  run_attempt: number;
  job_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  queue_duration_seconds: number | null;
  runtime_seconds: number | null;
  total_duration_seconds: number | null;
  steps?: Step[];
}

export interface WorkflowAttemptRow {
  run_id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  created_at: string | null;
  run_started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  queue_duration_seconds: number | null;
  runtime_seconds: number | null;
  total_duration_seconds: number | null;
  tracked: boolean;
  workflow_file: string | null;
  workflow_ref: string | null;
  workflow_path: string | null;
  workflow_parse_status: WorkflowParseStatus;
  match_kind: WorkflowMatchKind | null;
  jobs_fetched_at: string | null;
  steps_eligibility_checked_at: string | null;
  steps_collected_at: string | null;
  step_policy_hash: string | null;
  pr_numbers: number[];
  jobs: WorkflowAttemptJobRow[];
}

function secondsBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, (endMs - startMs) / 1000);
}

function getWorkflowPath(run: Run): string | null {
  if (typeof run.workflowPath === 'string') return run.workflowPath;
  const rawPath = run.githubPayload?.path;
  return typeof rawPath === 'string' ? rawPath : null;
}

function getRunAttempt(run: Run): number {
  if (Number.isInteger(run.runAttempt) && Number(run.runAttempt) > 0) return Number(run.runAttempt);
  const rawAttempt = run.githubPayload?.run_attempt;
  return Number.isInteger(rawAttempt) && Number(rawAttempt) > 0 ? Number(rawAttempt) : 1;
}

function getRunStartedAt(run: Run): string | null {
  if (run.run_started_at) return run.run_started_at;
  const rawStartedAt = run.githubPayload?.run_started_at;
  return typeof rawStartedAt === 'string' ? rawStartedAt : null;
}

function getPrNumbers(run: Run): number[] {
  const numbers = new Set<number>();
  for (const pullRequest of run.pull_requests ?? []) {
    if (typeof pullRequest.number === 'number') numbers.add(pullRequest.number);
  }
  return [...numbers];
}

function eligibleSteps(run: Run, thresholdSeconds: number): boolean {
  return run.conclusion === 'success' && (run.durationInSeconds ?? 0) > thresholdSeconds;
}

export function enrichRunWithWorkflowMetadata(
  run: Run,
  config: ReposConfig,
  repoConfig: RepoConfigEntry,
): Run {
  const workflowPath = getWorkflowPath(run);
  const parsed = parseWorkflowPath(workflowPath);
  const match = resolveWorkflowMatch(config, repoConfig, parsed);
  const runStartedAt = getRunStartedAt(run);
  const queueDuration = secondsBetween(run.created_at, runStartedAt);
  const runtime = secondsBetween(runStartedAt, run.updated_at);

  return {
    ...run,
    runAttempt: getRunAttempt(run),
    run_started_at: runStartedAt ?? undefined,
    queueDurationInSeconds: queueDuration ?? undefined,
    runtimeInSeconds: runtime ?? undefined,
    workflowFile: parsed.file,
    workflowRef: parsed.ref,
    workflowPath: workflowPath ?? undefined,
    workflowParseStatus: parsed.status,
    workflowMatchKind: match.kind,
    stepPolicyHash: stepPolicyHash(match),
    tracked: match.tracked,
  };
}

export function buildWorkflowAttempts(
  runs: Run[],
  config: ReposConfig,
  repoConfig: RepoConfigEntry,
  nowIso = new Date().toISOString(),
): WorkflowAttemptRow[] {
  return runs.map((inputRun) => {
    const run = enrichRunWithWorkflowMetadata(inputRun, config, repoConfig);
    const workflowPath = getWorkflowPath(run);
    const parsed = parseWorkflowPath(workflowPath);
    const match = resolveWorkflowMatch(config, repoConfig, parsed);
    const runAttempt = getRunAttempt(run);
    const runStartedAt = getRunStartedAt(run);
    const queueDuration = secondsBetween(run.created_at, runStartedAt);
    const runtime = secondsBetween(runStartedAt, run.updated_at);
    const total = secondsBetween(run.created_at, run.updated_at) ?? run.durationInSeconds ?? null;
    const shouldPersistSteps = match.tracked && eligibleSteps(run, match.stepThresholdSeconds);

    const jobs = (run.jobs ?? []).map((job): WorkflowAttemptJobRow => {
      const jobRuntime = secondsBetween(job.started_at, job.completed_at) ?? job.durationInSeconds ?? null;
      const jobTotal = secondsBetween(job.created_at, job.completed_at);
      return {
        run_id: run.id,
        run_attempt: runAttempt,
        job_id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion || null,
        created_at: job.created_at || null,
        started_at: job.started_at || null,
        completed_at: job.completed_at || null,
        html_url: job.html_url || null,
        queue_duration_seconds: job.queueDurationInSeconds ?? secondsBetween(job.created_at, job.started_at),
        runtime_seconds: jobRuntime,
        total_duration_seconds: jobTotal ?? ((job.queueDurationInSeconds ?? 0) + (jobRuntime ?? 0)),
        steps: shouldPersistSteps ? job.steps : undefined,
      };
    });

    return {
      run_id: run.id,
      run_attempt: runAttempt,
      status: run.status,
      conclusion: run.conclusion || null,
      created_at: run.created_at || null,
      run_started_at: runStartedAt,
      completed_at: run.updated_at || null,
      updated_at: run.updated_at || null,
      queue_duration_seconds: queueDuration,
      runtime_seconds: runtime,
      total_duration_seconds: total,
      tracked: match.tracked,
      workflow_file: parsed.file ?? null,
      workflow_ref: parsed.ref ?? null,
      workflow_path: workflowPath,
      workflow_parse_status: parsed.status,
      match_kind: match.kind ?? null,
      jobs_fetched_at: jobs.length > 0 ? nowIso : null,
      steps_eligibility_checked_at: match.tracked ? nowIso : null,
      steps_collected_at: shouldPersistSteps && jobs.some((job) => (job.steps?.length ?? 0) > 0) ? nowIso : null,
      step_policy_hash: stepPolicyHash(match),
      pr_numbers: getPrNumbers(run),
      jobs,
    };
  });
}

export function attemptToRun(attempt: WorkflowAttemptRow, base: Omit<Run, 'jobs'>, jobs: WorkflowAttemptJobRow[]): Run {
  return {
    ...base,
    id: attempt.run_id,
    runAttempt: attempt.run_attempt,
    status: attempt.status,
    conclusion: attempt.conclusion ?? '',
    created_at: attempt.created_at ?? base.created_at,
    run_started_at: attempt.run_started_at ?? undefined,
    updated_at: attempt.completed_at ?? attempt.updated_at ?? base.updated_at,
    durationInSeconds: attempt.total_duration_seconds ?? base.durationInSeconds,
    queueDurationInSeconds: attempt.queue_duration_seconds ?? undefined,
    runtimeInSeconds: attempt.runtime_seconds ?? undefined,
    workflowFile: attempt.workflow_file ?? undefined,
    workflowRef: attempt.workflow_ref ?? undefined,
    workflowPath: attempt.workflow_path ?? undefined,
    workflowParseStatus: attempt.workflow_parse_status,
    workflowMatchKind: attempt.match_kind ?? undefined,
    stepPolicyHash: attempt.step_policy_hash ?? undefined,
    tracked: attempt.tracked,
    jobs: jobs.map((job) => ({
      id: job.job_id,
      runAttempt: job.run_attempt,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? '',
      created_at: job.created_at ?? '',
      started_at: job.started_at ?? '',
      completed_at: job.completed_at ?? '',
      html_url: job.html_url ?? '',
      queueDurationInSeconds: job.queue_duration_seconds ?? 0,
      durationInSeconds: job.runtime_seconds ?? job.total_duration_seconds ?? 0,
      runtimeInSeconds: job.runtime_seconds ?? undefined,
      totalDurationInSeconds: job.total_duration_seconds ?? undefined,
      steps: job.steps,
    })),
  };
}

export function pullRequestRefsFromNumbers(numbers: number[]): PullRequestRef[] {
  return [...new Set(numbers)].map((number) => ({ number }));
}
