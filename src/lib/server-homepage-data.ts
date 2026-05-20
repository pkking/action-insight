import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';
import { createClient } from '@supabase/supabase-js';

import { parseTrackedReposYaml } from './tracked-repos.js';
import type { PullRequestIndexFile, PullRequestMetricsSummary } from './types';

export type RepoOption = {
  owner: string;
  repo: string;
  key: string;
};

function toRepoOption(entry: { owner: string; repo: string; slug: string }): RepoOption {
  return {
    owner: entry.owner,
    repo: entry.repo,
    key: entry.slug,
  };
}

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(supabaseUrl, supabaseKey);
}

export const getTrackedRepoOptions = cache(async (): Promise<RepoOption[]> => {
  const reposConfigPath = path.join(process.cwd(), 'etl', 'repos.yaml');
  const content = await readFile(reposConfigPath, 'utf-8');

  return parseTrackedReposYaml(content)
    .map(toRepoOption)
    .sort((left, right) => left.key.localeCompare(right.key));
});

async function getRepoId(owner: string, repo: string): Promise<number | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  return data?.id || null;
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

const getPullRequestIndex = cache(async (owner: string, repo: string): Promise<PullRequestIndexFile> => {
  const repoId = await getRepoId(owner, repo);

  if (!repoId) {
    return {
      repo: `${owner}/${repo}`,
      generated_at: new Date().toISOString(),
      prs: [],
      missingPrArtifact: true,
    };
  }

  const supabase = getSupabase();
  const { data: prs, error } = await supabase
    .from('pr_metrics')
    .select('*')
    .eq('repo_id', repoId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch PR index for ${owner}/${repo}: ${error.message}`);
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
});

export async function getHomepageData() {
  const repos = await getTrackedRepoOptions();
  const results = await Promise.allSettled(
    repos.map(async (repo) => ({
      key: repo.key,
      index: await getPullRequestIndex(repo.owner, repo.repo),
    }))
  );

  const repoIndexesByKey: Record<string, PullRequestIndexFile> = {};
  const failedRepoKeys: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      repoIndexesByKey[result.value.key] = result.value.index;
      continue;
    }

    failedRepoKeys.push(repos[index].key);
  }

  return {
    repoOptions: repos,
    repoIndexesByKey,
    failedRepoKeys,
  };
}
