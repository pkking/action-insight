import type {
  PullRequestIndexFile,
  PullRequestMetricsDetail,
  PullRequestMetricsSummary,
  PullRequestSnapshot,
  Run,
} from './types';

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

function diffSeconds(
  start?: string | null,
  end?: string | null,
  { clampNegative = false }: { clampNegative?: boolean } = {}
): number | undefined {
  if (!start || !end) {
    return undefined;
  }

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return undefined;
  }

  if (endMs < startMs) {
    return clampNegative ? 0 : undefined;
  }

  return Math.round((endMs - startMs) / 1000);
}

function summarizeConclusion(runs: Run[]): string {
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
    const ciStartedAt = [...prRuns]
      .map((run) => run.created_at)
      .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
    const ciCompletedAt = [...prRuns]
      .map((run) => run.updated_at)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
    const successfulWorkflowCount = prRuns.filter((run) => run.conclusion === 'success').length;

    const partialCiHistory = Boolean(metadata?.created_at && retentionStartDate && metadata.created_at < `${retentionStartDate}T00:00:00Z`);

    const summary: PullRequestMetricsSummary = {
      number,
      title: metadata?.title ?? `PR #${number}`,
      branch: workflows[0]?.head_branch ?? 'unknown',
      author: metadata?.user?.login ?? 'unknown',
      state: metadata?.state ?? 'unknown',
      html_url: metadata?.html_url ?? '',
      created_at: metadata?.created_at ?? ciStartedAt ?? workflows[0]?.created_at ?? generatedAt,
      ci_started_at: ciStartedAt,
      ci_completed_at: ciCompletedAt,
      merged_at: metadata?.merged_at ?? undefined,
      partialCiHistory,
      timeToCiStartInSeconds: diffSeconds(metadata?.created_at, ciStartedAt),
      ciDurationInSeconds: diffSeconds(ciStartedAt, ciCompletedAt),
      timeToMergeInSeconds: diffSeconds(metadata?.created_at, metadata?.merged_at),
      mergeLeadTimeInSeconds: diffSeconds(ciCompletedAt, metadata?.merged_at, { clampNegative: true }),
      workflowCount: prRuns.length,
      successfulWorkflowCount,
      conclusion: summarizeConclusion(prRuns),
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
