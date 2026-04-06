// Data fetcher library for reading from data branch via GitHub Raw URLs
import type { Index, DayData, Run } from './types';

const OWNER = 'pkking';
const REPO = 'action-insight';
const DATA_BRANCH = 'main';
const RAW_BASE = process.env.NODE_ENV === 'development' ? '' : `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

export async function fetchIndex(owner: string, repo: string): Promise<Index> {
  const res = await fetch(`${RAW_BASE}/data/${owner}/${repo}/index.json`, {
    // Prevent aggressive caching during development
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch index for ${owner}/${repo}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchDay(owner: string, repo: string, fileName: string): Promise<DayData> {
  const res = await fetch(`${RAW_BASE}/data/${owner}/${repo}/${fileName}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch data for ${fileName}: ${res.status}`);
  }
  return res.json();
}

export async function fetchRuns(owner: string, repo: string, days: number): Promise<Run[]> {
  const repoIndex = await fetchIndex(owner, repo);
  
  // Take the most recent `days` files
  const dates = repoIndex.files.slice(0, days);
  
  // Fetch all days in parallel
  const dayData = await Promise.allSettled(
    dates.map((date: string) => fetchDay(owner, repo, date))
  );

  // Aggregate runs, skipping failed days
  const runs: Run[] = [];
  for (const result of dayData) {
    if (result.status === 'fulfilled') {
      runs.push(...result.value.runs);
    }
    // Silently skip failed days (404, network error, etc.)
  }

  return runs;
}
