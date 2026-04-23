import type { PullRequestDetailFile, PullRequestIndexFile } from './types';

type RepoDescriptor = {
  owner: string;
  repo: string;
  key: string;
};

const OWNER = 'pkking';
const REPO = 'action-insight';
const DATA_BRANCH = 'main';
const RAW_BASE = process.env.NODE_ENV === 'development' ? '' : `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

export async function fetchPullRequestIndex(owner: string, repo: string): Promise<PullRequestIndexFile> {
  const res = await fetch(`${RAW_BASE}/data/${owner}/${repo}/prs/index.json`, {
    cache: 'no-store',
  });

  if (res.status === 404) {
    return {
      repo: `${owner}/${repo}`,
      generated_at: new Date().toISOString(),
      prs: [],
      missingPrArtifact: true,
    };
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch PR index for ${owner}/${repo}: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function fetchPullRequestDetail(owner: string, repo: string, number: number): Promise<PullRequestDetailFile> {
  const res = await fetch(`${RAW_BASE}/data/${owner}/${repo}/prs/${number}.json`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch PR detail for ${owner}/${repo}#${number}: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

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
