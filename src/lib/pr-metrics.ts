import type {
  PullRequestIndexFile,
  PullRequestMetricsDetail,
  PullRequestMetricsSummary,
  PullRequestSnapshot,
  Run,
} from './types';
import { diffSeconds } from './time-utils';

interface BuildPullRequestIndexOptions {
  repo: string;
  runs: Run[];
  pullRequests: Map<number, PullRequestSnapshot>;
  generatedAt?: string;
  retentionStartDate?: string;
}

interface BuildPullRequestIndexResult {
  index: PullRequestIndexFile;
  details: Map<number, PullRequestMetricsDetail>;
}

function isTerminalRun(run: Run): boolean {
  return run.status === 'completed' && run.conclusion.length > 0;
}

function isCountedAttempt(run: Run): boolean {
  return isTerminalRun(run) && run.conclusion !== 'skipped' && run.conclusion !== 'neutral';
}

function summarizeConclusion(runs: Run[]): string {
  if (runs.length === 0) {
    return 'unknown';
  }

  if (runs.every((run) => run.conclusion === 'success')) {
    return 'success';
  }

  const priority = ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped'];
  for (const value of priority) {
    if (runs.some((run) => run.conclusion === value)) {
      return value;
    }
  }

  return runs.find((run) => run.conclusion)?.conclusion ?? 'unknown';
}

function workflowGroupKey(run: Run): string {
  return `${run.workflowFile ?? run.name}@@${run.workflowRef ?? ''}`;
}

export function computePullRequestAttemptMetrics(runs: Run[]) {
  const terminalRuns = runs.filter(isTerminalRun);
  const countedRuns = terminalRuns.filter(isCountedAttempt);
  const successfulTerminalRuns = countedRuns.filter((run) => run.conclusion === 'success');

  const latestTerminalByWorkflow = new Map<string, Run>();
  const sortedForLatest = [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at || left.created_at);
    const rightTime = Date.parse(right.updated_at || right.created_at);
    if (leftTime !== rightTime) return rightTime - leftTime;
    if (left.id !== right.id) return right.id - left.id;
    return (right.runAttempt ?? 1) - (left.runAttempt ?? 1);
  });

  for (const run of sortedForLatest) {
    if (!isTerminalRun(run)) continue;
    const key = workflowGroupKey(run);
    if (!latestTerminalByWorkflow.has(key)) {
      latestTerminalByWorkflow.set(key, run);
    }
  }

  const latestTerminalRuns = Array.from(latestTerminalByWorkflow.values());
  const currentCiConclusion = latestTerminalRuns.length === 0
    ? (runs.length > 0 ? 'pending' : 'unknown')
    : summarizeConclusion(latestTerminalRuns);

  const terminalCreatedTimes = terminalRuns
    .map((run) => ({ createdAt: run.created_at, updatedAt: run.updated_at }))
    .filter((run) => run.createdAt && run.updatedAt);
  const ciStartedAt = terminalCreatedTimes
    .map((run) => run.createdAt)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
  const ciCompletedAt = terminalCreatedTimes
    .map((run) => run.updatedAt)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];

  return {
    ciStartedAt,
    ciCompletedAt,
    workflowCount: runs.length,
    successfulWorkflowCount: successfulTerminalRuns.length,
    attemptSuccessRate: countedRuns.length > 0
      ? Math.round((successfulTerminalRuns.length / countedRuns.length) * 100)
      : undefined,
    currentCiConclusion,
    conclusion: summarizeConclusion(latestTerminalRuns.length > 0 ? latestTerminalRuns : terminalRuns),
  };
}

export function buildPullRequestIndex({
  repo,
  runs,
  pullRequests,
  generatedAt = new Date().toISOString(),
  retentionStartDate,
}: BuildPullRequestIndexOptions): BuildPullRequestIndexResult {
  const groupedRuns = new Map<number, Run[]>();

  for (const run of runs) {
    const prNumber = run.pull_requests?.[0]?.number;
    if (!prNumber) {
      continue;
    }

    const existing = groupedRuns.get(prNumber) ?? [];
    existing.push(run);
    groupedRuns.set(prNumber, existing);
  }

  const prs: PullRequestMetricsSummary[] = [];
  const details = new Map<number, PullRequestMetricsDetail>();

  for (const [number, prRuns] of groupedRuns.entries()) {
    const metadata = pullRequests.get(number);
    const workflows = [...prRuns].sort(
      (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
    );
    const metrics = computePullRequestAttemptMetrics(prRuns);

    const partialCiHistory = Boolean(metadata?.created_at && retentionStartDate && metadata.created_at < `${retentionStartDate}T00:00:00Z`);

    const summary: PullRequestMetricsSummary = {
      number,
      title: metadata?.title ?? `PR #${number}`,
      branch: workflows[0]?.head_branch ?? 'unknown',
      author: metadata?.user?.login ?? 'unknown',
      state: metadata?.state ?? 'unknown',
      html_url: metadata?.html_url ?? '',
      created_at: metadata?.created_at ?? metrics.ciStartedAt ?? workflows[0]?.created_at ?? generatedAt,
      ci_started_at: metrics.ciStartedAt,
      ci_completed_at: metrics.ciCompletedAt,
      merged_at: metadata?.merged_at ?? undefined,
      partialCiHistory,
      timeToCiStartInSeconds: diffSeconds(metadata?.created_at, metrics.ciStartedAt),
      ciDurationInSeconds: diffSeconds(metrics.ciStartedAt, metrics.ciCompletedAt),
      timeToMergeInSeconds: diffSeconds(metadata?.created_at, metadata?.merged_at),
      mergeLeadTimeInSeconds: diffSeconds(metrics.ciCompletedAt, metadata?.merged_at, { clampNegative: true }),
      workflowCount: metrics.workflowCount,
      successfulWorkflowCount: metrics.successfulWorkflowCount,
      conclusion: metrics.conclusion,
      currentCiConclusion: metrics.currentCiConclusion,
      attemptSuccessRate: metrics.attemptSuccessRate,
    };

    prs.push(summary);
    details.set(number, {
      repo,
      generated_at: generatedAt,
      pr: {
        ...summary,
        workflows,
      },
    });
  }

  prs.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

  return {
    index: {
      repo,
      generated_at: generatedAt,
      prs,
    },
    details,
  };
}
