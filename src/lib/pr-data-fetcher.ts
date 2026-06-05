import { getTursoClient, getRepoId } from './turso';
import type { PullRequestDetailFile, PullRequestIndexFile, PullRequestMetricsSummary, Run } from './types';

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

export async function fetchPullRequestIndex(owner: string, repo: string): Promise<PullRequestIndexFile> {
  const repoId = await getRepoId(owner, repo);
  const client = getTursoClient();

  const { rows } = await client.execute({
    sql: `SELECT * FROM pr_metrics WHERE repo_id = ? ORDER BY created_at DESC`,
    args: [repoId],
  });

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
}

export async function fetchPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetailFile> {
  const repoId = await getRepoId(owner, repo);
  const client = getTursoClient();

  // Fetch PR metrics
  const { rows: prRows } = await client.execute({
    sql: `SELECT * FROM pr_metrics WHERE repo_id = ? AND pr_number = ?`,
    args: [repoId, number],
  });

  if (prRows.length === 0) {
    throw new Error(`PR #${number} not found for ${owner}/${repo}`);
  }

  const prData = prRows[0] as Record<string, unknown>;

  // Fetch PR workflows
  const { rows: workflowRows } = await client.execute({
    sql: `SELECT run_id FROM pr_workflows WHERE pr_metric_id = ?`,
    args: [prData.id as number],
  });

  let workflows: Run[] = [];

  if (workflowRows.length > 0) {
    const runIds = workflowRows.map((w) => w.run_id as number);
    const placeholders = runIds.map(() => '?').join(',');

    // Fetch runs with jobs via JOIN
    const { rows: runRows } = await client.execute({
      sql: `SELECT r.*, j.id AS job_id, j.name AS job_name, j.status AS job_status,
                   j.conclusion AS job_conclusion, j.created_at AS job_created_at,
                   j.started_at AS job_started_at, j.completed_at AS job_completed_at,
                   j.html_url AS job_html_url,
                   j.queue_duration_seconds, j.duration_seconds AS job_duration_seconds
            FROM runs r
            LEFT JOIN jobs j ON j.run_id = r.id
            WHERE r.id IN (${placeholders})
            ORDER BY r.created_at DESC`,
      args: runIds,
    });

    // Group by run
    const runMap = new Map<number, Run>();
    for (const row of runRows) {
      const runId = Number(row.id);
      if (!runMap.has(runId)) {
        runMap.set(runId, mapRunRow(row as Record<string, unknown>));
      }
      if (row.job_id != null) {
        const run = runMap.get(runId)!;
        run.jobs.push({
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
        });
      }
    }

    workflows = Array.from(runMap.values());
  }

  const summary = mapPrSummary(prData);

  return {
    repo: `${owner}/${repo}`,
    generated_at: new Date().toISOString(),
    pr: {
      ...summary,
      workflows,
    },
  };
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
