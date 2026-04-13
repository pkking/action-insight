import { NextResponse } from 'next/server';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

type RepoOption = {
  owner: string;
  repo: string;
  key: string;
};

export async function GET() {
  const dataDir = path.join(process.cwd(), 'data');

  try {
    const owners = await readdir(dataDir, { withFileTypes: true });
    const repos: RepoOption[] = [];

    for (const ownerEntry of owners) {
      if (!ownerEntry.isDirectory()) {
        continue;
      }

      const ownerDir = path.join(dataDir, ownerEntry.name);
      const repoEntries = await readdir(ownerDir, { withFileTypes: true });

      for (const repoEntry of repoEntries) {
        if (!repoEntry.isDirectory()) {
          continue;
        }

        repos.push({
          owner: ownerEntry.name,
          repo: repoEntry.name,
          key: `${ownerEntry.name}/${repoEntry.name}`,
        });
      }
    }

    repos.sort((a, b) => a.key.localeCompare(b.key));

    return NextResponse.json({ repos });
  } catch {
    return NextResponse.json({ repos: [] });
  }
}
