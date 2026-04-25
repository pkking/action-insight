import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';

import { parseTrackedReposYaml } from './tracked-repos.js';
import type { PullRequestIndexFile } from './types';

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

const getPullRequestIndex = cache(async (owner: string, repo: string): Promise<PullRequestIndexFile> => {
  const filePath = path.join(process.cwd(), 'data', owner, repo, 'prs', 'index.json');

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as PullRequestIndexFile;
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

    if (errorCode === 'ENOENT') {
      return {
        repo: `${owner}/${repo}`,
        generated_at: new Date().toISOString(),
        prs: [],
        missingPrArtifact: true,
      };
    }

    if (error instanceof SyntaxError) {
      console.error(`[server-homepage-data] Failed to parse index.json for ${owner}/${repo}:`, error.message);
    }

    throw error;
  }
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
