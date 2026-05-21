import { getSupabaseClient } from './supabase';
import type { Index, DayData, Run, Job } from './types';

async function getRepoId(owner: string, repo: string): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  if (error || !data) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  return data.id;
}

function mapRunRow(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    name: row.name as string,
    head_branch: row.head_branch as string,
    head_sha: row.head_sha as string | undefined,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    event: row.event as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    html_url: row.html_url as string,
    durationInSeconds: Number(row.duration_seconds),
    pull_requests: [],
    jobs: [],
  };
}

function mapJobRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id),
    name: row.name as string,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    created_at: row.created_at as string,
    started_at: row.started_at as string,
    completed_at: row.completed_at as string,
    html_url: row.html_url as string,
    queueDurationInSeconds: Number(row.queue_duration_seconds),
    durationInSeconds: Number(row.duration_seconds),
  };
}

export interface FetchRunsOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  now?: Date;
}

export async function fetchIndex(owner: string, repo: string): Promise<Index> {
  const repoId = await getRepoId(owner, repo);
  const supabase = getSupabaseClient();

  const { data: dates, error } = await supabase
    .from('runs')
    .select('date')
    .eq('repo_id', repoId)
    .order('date', { ascending: false });

  if (error) {
    if (typeof window === 'undefined') console.error('Supabase error fetching index:', error);
    throw new Error(`Failed to fetch index for ${owner}/${repo}: database query failed`);
  }

  const uniqueDates = [...new Set(dates.map((d) => `${d.date}`))];
  const files = uniqueDates.map((d) => `${d}.json`);
  const latest = files[0]?.replace('.json', '') || '';

  return {
    version: 1,
    latest,
    files,
    retention_days: 90,
    last_updated: new Date().toISOString(),
    history_complete: true,
  };
}

export async function fetchDay(owner: string, repo: string, fileName: string): Promise<DayData> {
  const date = fileName.replace('.json', '');
  const repoId = await getRepoId(owner, repo);
  const supabase = getSupabaseClient();

  const { data: runs, error } = await supabase
    .from('runs')
    .select('*, jobs(*)')
    .eq('repo_id', repoId)
    .eq('date', date);

  if (error) {
    if (typeof window === 'undefined') console.error('Supabase error fetching day data:', error);
    throw new Error(`Failed to fetch data for ${fileName}: database query failed`);
  }

  const mappedRuns: Run[] = (runs || []).map((row) => {
    const run = mapRunRow(row);
    if (row.jobs && Array.isArray(row.jobs)) {
      run.jobs = row.jobs.map((j: Record<string, unknown>) => mapJobRow(j));
    }
    return run;
  });

  return { date, repo: `${owner}/${repo}`, runs: mappedRuns };
}

async function fetchRunsFromDb(repoId: number, dateFilter: { startDate?: string; endDate?: string; limit?: number }): Promise<Run[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('runs')
    .select('*, jobs(*)')
    .eq('repo_id', repoId)
    .order('date', { ascending: false });

  if (dateFilter.startDate && dateFilter.endDate) {
    query = query.gte('date', dateFilter.startDate).lte('date', dateFilter.endDate);
  }

  if (dateFilter.limit) {
    query = query.limit(dateFilter.limit);
  }

  const { data: runs, error } = await query;

  if (error) {
    if (typeof window === 'undefined') console.error('Supabase error fetching runs:', error);
    throw new Error(`Failed to fetch runs: database query failed`);
  }

  return (runs || []).map((row) => {
    const run = mapRunRow(row);
    if (row.jobs && Array.isArray(row.jobs)) {
      run.jobs = row.jobs.map((j: Record<string, unknown>) => mapJobRow(j));
    }
    return run;
  });
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

async function fetchRunsFromFiles(owner: string, repo: string, files: string[]): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);
  const allRuns: Run[] = [];

  for (const file of files) {
    const date = file.replace('.json', '');
    const runs = await fetchRunsFromDb(repoId, { startDate: date, endDate: date });
    allRuns.push(...runs);
  }

  return allRuns;
}

export async function fetchRuns(owner: string, repo: string, options: FetchRunsOptions = {}): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  if (options.startDate && options.endDate) {
    return fetchRunsFromDb(repoId, { startDate: options.startDate, endDate: options.endDate });
  }

  const { days = 7, now = new Date() } = options;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return fetchRunsFromDb(repoId, { startDate: cutoffDate, endDate: undefined });
}

export async function fetchRunsFromIndex(
  owner: string,
  repo: string,
  repoIndex: Index,
  options: FetchRunsOptions = {}
): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  if (options.startDate && options.endDate) {
    return fetchRunsFromDb(repoId, { startDate: options.startDate, endDate: options.endDate });
  }

  const dates = selectFiles(repoIndex.files, options);
  if (dates.length === 0) return [];

  const firstDate = dates[dates.length - 1].replace('.json', '');
  const lastDate = dates[0].replace('.json', '');

  return fetchRunsFromDb(repoId, { startDate: firstDate, endDate: lastDate });
}

export async function fetchLatestRuns(owner: string, repo: string, maxFiles = 7): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);
  return fetchRunsFromDb(repoId, { limit: maxFiles * 20 });
}

export async function fetchLatestRunsFromIndex(
  owner: string,
  repo: string,
  repoIndex: Index,
  maxFiles = 7
): Promise<Run[]> {
  const latestFiles = [...repoIndex.files]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, maxFiles);

  return fetchRunsFromFiles(owner, repo, latestFiles);
}
