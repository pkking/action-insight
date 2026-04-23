import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

type RepoOption = {
  owner: string;
  repo: string;
  key: string;
};

type ReposConfig = {
  repos?: unknown;
};

function toRepoOption(entry: string): RepoOption | null {
  const [owner, repo] = entry.split('/');

  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    key: `${owner}/${repo}`,
  };
}

function parseReposConfig(content: string): RepoOption[] {
  const config = yaml.load(content) as ReposConfig | null;
  const entries = Array.isArray(config?.repos) ? config.repos : [];

  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => toRepoOption(entry.trim()))
    .filter((repo): repo is RepoOption => repo !== null);
}

export async function GET() {
  const reposConfigPath = path.join(process.cwd(), 'etl', 'repos.yaml');

  try {
    const content = await readFile(reposConfigPath, 'utf-8');
    const repos = parseReposConfig(content);
    repos.sort((a, b) => a.key.localeCompare(b.key));

    return NextResponse.json({ repos });
  } catch {
    return NextResponse.json({ repos: [] });
  }
}
