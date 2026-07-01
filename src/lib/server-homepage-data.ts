import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';

import { getTursoClient, getRepoId as _getRepoId } from './turso';
import { parseTrackedReposYaml } from './tracked-repos.js';
import type { PullRequestIndexFile, PullRequestMetricsSummary, TestCaseStats } from './types';

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

export const getTrackedRepoOptions = cache(async (): Promise<RepoOption[]> => {
  const reposConfigPath = path.join(process.cwd(), 'etl', 'repos.yaml');
  const content = await readFile(reposConfigPath, 'utf-8');

  return parseTrackedReposYaml(content)
    .map(toRepoOption)
    .sort((left, right) => left.key.localeCompare(right.key));
});

const getTestCaseStats = cache(async (owner: string, repo: string): Promise<TestCaseStats | null> => {
  let repoId: number;
  try {
    repoId = await _getRepoId(owner, repo);
  } catch {
    return null;
  }

  const client = getTursoClient();
  const { rows } = await client.execute({
    sql: `SELECT * FROM test_case_stats WHERE repo_id = ? ORDER BY generated_at DESC LIMIT 1`,
    args: [repoId],
  });

  if (rows.length === 0) return null;

  const data = rows[0];
  return {
    total_test_cases: data.total_test_cases as number,
    ascend_test_cases: data.ascend_test_cases as number,
    nvidia_test_cases: data.nvidia_test_cases as number,
    window_start: data.window_start as string,
    window_end: data.window_end as string,
    generated_at: data.generated_at as string,
  };
});

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
  let repoId: number;
  try {
    repoId = await _getRepoId(owner, repo);
  } catch {
    return {
      repo: `${owner}/${repo}`,
      generated_at: new Date().toISOString(),
      prs: [],
      missingPrArtifact: true,
    };
  }

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
});

export async function getHomepageData() {
  const repos = await getTrackedRepoOptions();
  const results = await Promise.allSettled(
    repos.map(async (repo) => ({
      key: repo.key,
      index: await getPullRequestIndex(repo.owner, repo.repo),
      testCaseStats: await getTestCaseStats(repo.owner, repo.repo),
    }))
  );

  const repoIndexesByKey: Record<string, PullRequestIndexFile> = {};
  const testCaseStatsByKey: Record<string, TestCaseStats | null> = {};
  const failedRepoKeys: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      repoIndexesByKey[result.value.key] = result.value.index;
      testCaseStatsByKey[result.value.key] = result.value.testCaseStats;
      continue;
    }

    failedRepoKeys.push(repos[index].key);
  }

  return {
    repoOptions: repos,
    repoIndexesByKey,
    testCaseStatsByKey,
    failedRepoKeys,
  };
}
