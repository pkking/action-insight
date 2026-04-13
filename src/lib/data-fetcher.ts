// Data fetcher library for reading from data branch via GitHub Raw URLs
import type { Index, DayData, Run } from './types';

const OWNER = 'pkking';
const REPO = 'action-insight';
const DATA_BRANCH = 'main';
const RAW_BASE = process.env.NODE_ENV === 'development' ? '' : `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

export interface FetchRunsOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  now?: Date;
}

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

function selectFiles(files: string[], options: FetchRunsOptions): string[] {
  const { days = 7, startDate, endDate, now = new Date() } = options;

  if (startDate && endDate) {
    return files.filter((file) => {
      const date = file.replace(/\.json$/, '');
      return date >= startDate && date <= endDate;
    });
  }

  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return files.filter((file) => file.replace(/\.json$/, '') >= cutoffDate);
}

export async function fetchRuns(owner: string, repo: string, options: FetchRunsOptions = {}): Promise<Run[]> {
  const repoIndex = await fetchIndex(owner, repo);

  const dates = selectFiles(repoIndex.files, options);

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
