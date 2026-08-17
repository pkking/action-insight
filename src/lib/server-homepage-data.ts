import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';

import { parseTrackedReposYaml } from './tracked-repos.js';

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
