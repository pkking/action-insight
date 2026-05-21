import { getSupabaseClient } from './supabase';
import type { PullRequestDetailFile, PullRequestIndexFile, PullRequestMetricsSummary, Run } from './types';

async function getRepoId(owner: string, repo: string): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  if (error || !data) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  return data.id;
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

export async function fetchPullRequestIndex(owner: string, repo: string): Promise<PullRequestIndexFile> {
  const repoId = await getRepoId(owner, repo);
  const supabase = getSupabaseClient();

  const { data: prs, error } = await supabase
    .from('pr_metrics')
    .select('*')
    .eq('repo_id', repoId)
    .order('created_at', { ascending: false });

  if (error) {
    if (typeof window === 'undefined') console.error('Supabase error fetching PR index:', error);
    throw new Error(`Failed to fetch PR index for ${owner}/${repo}: database query failed`);
  }

  if (!prs || prs.length === 0) {
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
    prs: prs.map(mapPrSummary),
  };
}

export async function fetchPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetailFile> {
  const repoId = await getRepoId(owner, repo);
  const supabase = getSupabaseClient();

  const { data: prData, error } = await supabase
    .from('pr_metrics')
    .select('*')
    .eq('repo_id', repoId)
    .eq('pr_number', number)
    .single();

  if (error || !prData) {
    throw new Error(`PR #${number} not found for ${owner}/${repo}`);
  }

  const { data: prWorkflows } = await supabase
    .from('pr_workflows')
    .select('run_id')
    .eq('pr_metric_id', prData.id);

  let workflows: Run[] = [];

  if (prWorkflows && prWorkflows.length > 0) {
    const runIds = prWorkflows.map((pw) => pw.run_id);
    const { data: runs } = await supabase
      .from('runs')
      .select('*, jobs(*)')
      .in('id', runIds);

    if (runs) {
      workflows = runs.map((row) => {
        const run = mapRunRow(row);
        if (row.jobs && Array.isArray(row.jobs)) {
          run.jobs = row.jobs.map((j: Record<string, unknown>) => ({
            id: Number(j.id),
            name: j.name as string,
            status: j.status as string,
            conclusion: (j.conclusion as string) || '',
            created_at: j.created_at as string,
            started_at: j.started_at as string,
            completed_at: j.completed_at as string,
            html_url: j.html_url as string,
            queueDurationInSeconds: Number(j.queue_duration_seconds),
            durationInSeconds: Number(j.duration_seconds),
          }));
        }
        return run;
      });
    }
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
