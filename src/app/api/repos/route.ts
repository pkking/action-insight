import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseTrackedReposYaml } from '@/lib/tracked-repos';

type RepoOption = {
  owner: string;
  repo: string;
  key: string;
};

function parseReposConfig(content: string): RepoOption[] {
  return parseTrackedReposYaml(content).map((entry) => ({
    owner: entry.owner,
    repo: entry.repo,
    key: entry.slug,
  }));
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
