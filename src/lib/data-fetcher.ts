// Data fetcher library for reading from data branch via GitHub Raw URLs
import type { Index, DayData, Run } from './types';

const OWNER = 'pkking';
const REPO = 'action-insight';
const DATA_BRANCH = 'data';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

export async function fetchIndex(): Promise<Index> {
  const res = await fetch(`${RAW_BASE}/data/index.json`, {
    // Prevent aggressive caching during development
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch index: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchDay(date: string): Promise<DayData> {
  const res = await fetch(`${RAW_BASE}/data/${date}.json`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch data for ${date}: ${res.status}`);
  }
  return res.json();
}

export async function fetchRuns(days: number): Promise<Run[]> {
  const index = await fetchIndex();
  const repoKey = 'vllm-project/vllm-ascend';
  const repoIndex = index.repos[repoKey];
  
  if (!repoIndex) {
    throw new Error(`No data found for repo: ${repoKey}`);
  }

  // Take the most recent `days` files
  const dates = repoIndex.files.slice(0, days);
  
  // Fetch all days in parallel
  const dayData = await Promise.allSettled(
    dates.map(date => fetchDay(date))
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
