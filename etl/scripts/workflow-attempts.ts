import type { PullRequestRef, Run, Step } from '../../src/lib/types.ts';
import type { ReposConfig, RepoConfigEntry } from './repos-config.ts';
import { resolveWorkflowMatch, stepPolicyHash, type WorkflowMatchKind } from './workflow-match.ts';
import { parseWorkflowPath, type WorkflowParseStatus } from './workflow-path.ts';

export interface TimingEvidence {
  version: 1;
  queue_duration_seconds?: number;
  runtime_seconds?: number;
  total_duration_seconds?: number;
  completion_source?: string;
  completed_at?: string;
  trigger_at?: string;
}

export interface WorkflowAttemptJobRow {
  timing_evidence?: TimingEvidence;
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
  labels?: string[];
  runner_id?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  resource_model?: string;
  resource_count?: number;
  steps?: Step[];
}

export interface WorkflowAttemptRow {
  timing_evidence?: TimingEvidence;
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
  return endMs < startMs ? null : (endMs - startMs) / 1000;
}

function rawTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function addDuration(evidence: TimingEvidence, key: 'queue_duration_seconds' | 'runtime_seconds' | 'total_duration_seconds', start: unknown, end: unknown): void {
  const duration = secondsBetween(rawTimestamp(start), rawTimestamp(end));
  if (duration !== null) evidence[key] = duration;
}

function nonemptyEvidence(evidence: TimingEvidence): TimingEvidence | undefined {
  return Object.keys(evidence).length > 1 ? evidence : undefined;
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
  const duration = getRunAttempt(run) > 1 ? run.runtimeInSeconds : run.durationInSeconds;
  return run.conclusion === 'success' && duration != null && duration > thresholdSeconds;
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
  const firstJobStartedAt = run.jobs
    ?.map((job) => job.started_at)
    .filter((startedAt): startedAt is string => Boolean(startedAt))
    .sort((left, right) => left.localeCompare(right))[0];
  // ADR-023: a rerun attempt's trigger time is unknowable — the run's
  // created_at stays at the ORIGINAL trigger, so created→started would count
  // the idle gap between attempts as queue. Rerun queue is unknown (null).
  const queueDuration =
    getRunAttempt(run) > 1
      ? null
      : secondsBetween(run.created_at, firstJobStartedAt);
  // updated_at is only a completion proxy for completed attempts.
  const startMs = runStartedAt ? Date.parse(runStartedAt) : NaN;
  const endMs = run.updated_at ? Date.parse(run.updated_at) : NaN;
  const runtime = run.status === 'completed' && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? (endMs - startMs) / 1000 : null;

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
    // enrich already parsed the path; reuse its result to re-derive only the
    // threshold (not stored on Run) for step eligibility.
    const match = resolveWorkflowMatch(config, repoConfig, {
      file: run.workflowFile,
      ref: run.workflowRef,
      status: run.workflowParseStatus ?? 'file_unavailable',
    });
    const runStartedAt = run.run_started_at ?? null;
    const queueDuration = run.queueDurationInSeconds ?? null;
    const runtime = run.runtimeInSeconds ?? null;
    // A rerun's request time is unknown; runtime is not trigger-to-completion.
    const total = getRunAttempt(run) > 1 || run.status !== 'completed' ? null :
      secondsBetween(run.created_at, run.updated_at);
    const shouldPersistSteps = match.tracked && eligibleSteps(run, match.stepThresholdSeconds);

    // Evidence is independent of the legacy display/step-eligibility values.
    const raw = inputRun.githubPayload;
    const boundRun = raw && raw.id === inputRun.id && raw.run_attempt === getRunAttempt(inputRun)
      && raw.status === inputRun.status && typeof raw.status === 'string';
    const runEvidence: TimingEvidence = { version: 1 };
    if (boundRun) {
      const completedAt = raw.status === 'completed' ? rawTimestamp(raw.completed_at) : null;
      if (completedAt) {
        addDuration(runEvidence, 'runtime_seconds', raw.run_started_at, completedAt);
        if (getRunAttempt(inputRun) === 1) addDuration(runEvidence, 'total_duration_seconds', raw.created_at, completedAt);
        if (runEvidence.runtime_seconds !== undefined || runEvidence.total_duration_seconds !== undefined) {
          runEvidence.completion_source = 'github_run.completed_at';
          runEvidence.completed_at = completedAt;
        }
      }
    }
    // A fetch marker must belong to this assembly and postdate the attempt's
    // endpoints; raw job identity binds every member to the same attempt.
    const fetchedAt = (inputRun as Run & { jobsFetchedAt?: string }).jobsFetchedAt;
    const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
    const rawStart = boundRun ? rawTimestamp(raw.run_started_at) : null;
    const rawCompletion = boundRun ? rawTimestamp(raw.completed_at) : null;
    const collectionBound = Boolean(Array.isArray(inputRun.jobs) && Number.isFinite(fetchedMs)
      && (!rawStart || fetchedMs >= Date.parse(rawStart))
      && (!rawCompletion || fetchedMs >= Date.parse(rawCompletion))
      && inputRun.jobs.every((job) => {
        const payload = job.githubPayload;
        return payload?.id === job.id && payload.run_id === inputRun.id
          && payload.run_attempt === getRunAttempt(inputRun) && payload.status === job.status
          && [payload.created_at, payload.started_at, payload.completed_at].every((value) => {
            const timestamp = rawTimestamp(value);
            return !timestamp || Date.parse(timestamp) <= fetchedMs;
          });
      }));
    if (collectionBound && boundRun && getRunAttempt(inputRun) === 1 && raw) {
      const starts = inputRun.jobs!.map((job) => rawTimestamp(job.githubPayload?.started_at));
      if (starts.length > 0 && starts.every((start): start is string => start !== null)) {
        starts.sort((left, right) => Date.parse(left) - Date.parse(right));
        addDuration(runEvidence, 'queue_duration_seconds', raw.created_at, starts[0]);
      }
    }

    if (boundRun && raw.run_attempt === 1 &&
      (runEvidence.total_duration_seconds !== undefined || runEvidence.queue_duration_seconds !== undefined)) {
      runEvidence.trigger_at = rawTimestamp(raw.created_at)!;
    }

    const jobs = (run.jobs ?? []).map((job): WorkflowAttemptJobRow => {
      const jobEvidence: TimingEvidence = { version: 1 };
      if (collectionBound && job.githubPayload) {
        const payload = job.githubPayload;
        addDuration(jobEvidence, 'queue_duration_seconds', payload.created_at, payload.started_at);
        if (payload.status === 'completed') {
          addDuration(jobEvidence, 'runtime_seconds', payload.started_at, payload.completed_at);
          addDuration(jobEvidence, 'total_duration_seconds', payload.created_at, payload.completed_at);
          if (jobEvidence.runtime_seconds !== undefined || jobEvidence.total_duration_seconds !== undefined) {
            jobEvidence.completion_source = 'github_job.completed_at';
            jobEvidence.completed_at = rawTimestamp(payload.completed_at)!;
          }
        }
      }
      const jobRuntime = secondsBetween(job.started_at, job.completed_at);
      const jobTotal = secondsBetween(job.created_at, job.completed_at);
      return {
        run_id: run.id,
        ...(nonemptyEvidence(jobEvidence) ? { timing_evidence: jobEvidence } : {}),
        run_attempt: run.runAttempt ?? 1,
        job_id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion || null,
        created_at: job.created_at || null,
        started_at: job.started_at || null,
        completed_at: jobEvidence.completed_at ?? job.completed_at ?? null,
        html_url: job.html_url || null,
        queue_duration_seconds: secondsBetween(job.created_at, job.started_at),
        runtime_seconds: jobRuntime,
        total_duration_seconds: jobTotal,
        labels: job.labels,
        runner_id: job.runner_id,
        runner_name: job.runner_name,
        runner_group_id: job.runner_group_id,
        runner_group_name: job.runner_group_name,
        resource_model: job.resource_model,
        resource_count: job.resource_count,
        steps: shouldPersistSteps ? job.steps : undefined,
      };
    });

    return {
      run_id: run.id,
      ...(nonemptyEvidence(runEvidence) ? { timing_evidence: runEvidence } : {}),
      run_attempt: run.runAttempt ?? 1,
      status: run.status,
      conclusion: run.conclusion || null,
      created_at: run.created_at || null,
      run_started_at: runStartedAt,
      completed_at: run.status === 'completed' ? ((runEvidence.completion_source ? rawTimestamp(raw?.completed_at) : null) ?? run.updated_at ?? null) : null,
      updated_at: run.updated_at || null,
      queue_duration_seconds: queueDuration,
      runtime_seconds: runtime,
      total_duration_seconds: total,
      tracked: match.tracked,
      workflow_file: run.workflowFile ?? null,
      workflow_ref: run.workflowRef ?? null,
      workflow_path: run.workflowPath ?? null,
      workflow_parse_status: run.workflowParseStatus ?? 'file_unavailable',
      match_kind: run.workflowMatchKind ?? null,
      jobs_fetched_at: Array.isArray(inputRun.jobs) && rawTimestamp(fetchedAt) ? fetchedAt! : null,
      steps_eligibility_checked_at: match.tracked ? nowIso : null,
      steps_collected_at: shouldPersistSteps && jobs.some((job) => (job.steps?.length ?? 0) > 0) ? nowIso : null,
      step_policy_hash: run.stepPolicyHash ?? stepPolicyHash(match),
      pr_numbers: getPrNumbers(run),
      jobs,
    };
  });
}


