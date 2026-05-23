/**
 * Supabase storage adapter for ETL pipeline.
 * Writes runs, jobs, and PR metrics to Supabase database.
 */

import { createClient } from '@supabase/supabase-js';

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
}

interface Run {
  id: number;
  name: string;
  head_branch: string;
  head_sha?: string;
  status: string;
  conclusion: string;
  event?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  pull_requests?: { number: number }[];
  jobs?: Job[];
}

interface PrMetricsSummary {
  number: number;
  title: string;
  branch: string;
  author?: string;
  state: string;
  html_url: string;
  created_at: string;
  ci_started_at?: string;
  ci_completed_at?: string;
  merged_at?: string | null;
  partialCiHistory: boolean;
  timeToCiStartInSeconds?: number;
  ciDurationInSeconds?: number;
  timeToMergeInSeconds?: number;
  mergeLeadTimeInSeconds?: number;
  workflowCount: number;
  successfulWorkflowCount: number;
  conclusion: string;
}

export interface PullRequestResolutionCacheEntry {
  head_sha: string;
  pr_number: number;
  source?: string;
}

let cachedClient: ReturnType<typeof createClient> | null = null;
const SUPABASE_PAGE_SIZE = 1000;
const PR_RESOLUTION_SOURCE_PRIORITY: Record<string, number> = {
  run_payload: 1,
  workflow_run: 1,
  search_api: 2,
  commits_api: 3,
};

function getSupabase() {
  if (cachedClient) return cachedClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  cachedClient = createClient(supabaseUrl, supabaseKey);
  return cachedClient;
}

function getPrResolutionSourcePriority(source?: string): number {
  return PR_RESOLUTION_SOURCE_PRIORITY[source ?? 'commits_api'] ?? 0;
}

async function ensureRepo(owner: string, repo: string): Promise<number | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  // Upsert with ignoreDuplicates to avoid race condition when concurrent
  // workflows try to register the same repo simultaneously.
  await supabase
    .from('repos')
    .upsert({ owner, repo }, { onConflict: 'owner,repo', ignoreDuplicates: true });

  const { data } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  return data?.id ?? null;
}

export async function writeRunsToSupabase(repo: string, runs: Run[], date: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return;

  if (runs.length === 0) return;

  const runRows = runs.map((run) => ({
    id: run.id,
    repo_id: repoId,
    name: run.name,
    head_branch: run.head_branch,
    head_sha: run.head_sha || null,
    status: run.status,
    conclusion: run.conclusion || null,
    event: run.event || null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    duration_seconds: run.durationInSeconds,
    date,
  }));

  const { error: runError } = await supabase
    .from('runs')
    .upsert(runRows, { onConflict: 'id' });

  if (runError) {
    console.error(`  [Supabase] Error inserting runs: ${runError.message}`);
    return;
  }

  const jobRows: {
    id: number;
    run_id: number;
    name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    started_at: string;
    completed_at: string;
    html_url: string;
    queue_duration_seconds: number;
    duration_seconds: number;
  }[] = [];

  for (const run of runs) {
    if (run.jobs && run.jobs.length > 0) {
      for (const job of run.jobs) {
        jobRows.push({
          id: job.id,
          run_id: run.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion || null,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          html_url: job.html_url,
          queue_duration_seconds: job.queueDurationInSeconds,
          duration_seconds: job.durationInSeconds,
        });
      }
    }
  }

  if (jobRows.length > 0) {
    const { error: jobError } = await supabase
      .from('jobs')
      .upsert(jobRows, { onConflict: 'id' });

    if (jobError) {
      console.error(`  [Supabase] Error inserting jobs: ${jobError.message}`);
    }
  }
}

export async function getExistingRunIdsFromSupabase(repo: string): Promise<Set<number>> {
  const supabase = getSupabase();
  if (!supabase) return new Set();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return new Set();

  const { data, error } = await supabase
    .from('runs')
    .select('id')
    .eq('repo_id', repoId);

  if (error) {
    console.error(`  [Supabase] Error fetching existing run IDs: ${error.message}`);
    return new Set();
  }

  return new Set((data || []).map((row: { id: number }) => row.id));
}

export async function getExistingRunIdsWithJobsFromSupabase(repo: string): Promise<Set<number>> {
  const supabase = getSupabase();
  if (!supabase) return new Set();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return new Set();

  const runIds = new Set<number>();
  let from = 0;
  let useRpc = true;

  while (true) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = useRpc
      ? await supabase
          .rpc('get_run_ids_with_jobs', { p_repo_id: repoId })
          .range(from, to)
      : await supabase
          .from('runs')
          .select('id, jobs!inner(id)')
          .eq('repo_id', repoId)
          .range(from, to);

    if (error) {
      if (useRpc) {
        console.warn(
          `  [Supabase] RPC get_run_ids_with_jobs unavailable, falling back to paginated join: ${error.message}`
        );
        useRpc = false;
        from = 0;
        runIds.clear();
        continue;
      }

      console.error(`  [Supabase] Error fetching existing run IDs with jobs: ${error.message}`);
      return runIds;
    }

    for (const row of data || []) {
      runIds.add(Number(useRpc ? row.run_id : row.id));
    }

    if (!data || data.length < SUPABASE_PAGE_SIZE) {
      break;
    }

    from += SUPABASE_PAGE_SIZE;
  }

  return runIds;
}

export async function readPullRequestResolutionCacheFromSupabase(
  repo: string,
  shas: string[],
): Promise<Map<string, number>> {
  const supabase = getSupabase();
  if (!supabase || shas.length === 0) return new Map();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return new Map();

  const resolved = new Map<string, number>();
  const uniqueShas = Array.from(new Set(shas));

  for (let i = 0; i < uniqueShas.length; i += 100) {
    const batch = uniqueShas.slice(i, i + 100);
    const { data, error } = await supabase
      .from('pr_resolution_cache')
      .select('head_sha, pr_number')
      .eq('repo_id', repoId)
      .in('head_sha', batch);

    if (error) {
      console.error(`  [Supabase] Error reading PR resolution cache: ${error.message}`);
      continue;
    }

    for (const row of data || []) {
      if (typeof row.head_sha === 'string' && typeof row.pr_number === 'number') {
        resolved.set(row.head_sha, row.pr_number);
      }
    }
  }

  return resolved;
}

export async function writePullRequestResolutionCacheToSupabase(
  repo: string,
  entries: PullRequestResolutionCacheEntry[],
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase || entries.length === 0) return;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return;

  const entriesBySha = new Map<string, PullRequestResolutionCacheEntry>();
  for (const entry of entries) {
    const existing = entriesBySha.get(entry.head_sha);
    if (
      !existing ||
      getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source)
    ) {
      entriesBySha.set(entry.head_sha, entry);
    }
  }
  const uniqueEntries = Array.from(entriesBySha.values());
  const existingEntries = new Map<string, { source: string }>();
  const uniqueShas = uniqueEntries.map((entry) => entry.head_sha);

  for (let i = 0; i < uniqueShas.length; i += 100) {
    const batch = uniqueShas.slice(i, i + 100);
    const { data, error } = await supabase
      .from('pr_resolution_cache')
      .select('head_sha, pr_number, source')
      .eq('repo_id', repoId)
      .in('head_sha', batch);

    if (error) {
      console.error(`  [Supabase] Error checking PR resolution cache priority: ${error.message}`);
      continue;
    }

    for (const row of data || []) {
      if (
        typeof row.head_sha === 'string' &&
        typeof row.pr_number === 'number' &&
        typeof row.source === 'string'
      ) {
        existingEntries.set(row.head_sha, { source: row.source });
      }
    }
  }

  const rows = uniqueEntries
    .filter((entry) => {
      const existing = existingEntries.get(entry.head_sha);
      if (!existing) return true;

      return getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source);
    })
    .map((entry) => ({
      repo_id: repoId,
      head_sha: entry.head_sha,
      pr_number: entry.pr_number,
      source: entry.source ?? 'commits_api',
    }));

  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase
      .from('pr_resolution_cache')
      .upsert(batch, { onConflict: 'repo_id,head_sha' });

    if (error) {
      console.error(`  [Supabase] Error writing PR resolution cache: ${error.message}`);
    }
  }
}

export async function writePrWorkflowsToSupabase(repo: string, prWorkflows: Map<number, number[]>): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  if (prWorkflows.size === 0) return;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return;

  const { data: prMetrics, error: lookupError } = await supabase
    .from('pr_metrics')
    .select('id, pr_number')
    .eq('repo_id', repoId)
    .in('pr_number', Array.from(prWorkflows.keys()));

  if (lookupError) {
    console.error(`  [Supabase] Error looking up PR metric IDs: ${lookupError.message}`);
    return;
  }

  const prNumberToId = new Map((prMetrics || []).map((row: { id: number; pr_number: number }) => [row.pr_number, row.id]));

  const workflowRows: { pr_metric_id: number; run_id: number }[] = [];
  for (const [prNumber, runIds] of prWorkflows.entries()) {
    const prMetricId = prNumberToId.get(prNumber);
    if (!prMetricId) continue;
    for (const runId of runIds) {
      workflowRows.push({ pr_metric_id: prMetricId, run_id: runId });
    }
  }

  if (workflowRows.length === 0) return;

  const { error } = await supabase
    .from('pr_workflows')
    .upsert(workflowRows, { onConflict: 'pr_metric_id,run_id' });

  if (error) {
    console.error(`  [Supabase] Error inserting PR workflows: ${error.message}`);
  }
}

export async function writePrMetricsToSupabase(repo: string, prs: PrMetricsSummary[]): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  if (prs.length === 0) return;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return;

  const prRows = prs.map((pr) => ({
    repo_id: repoId,
    pr_number: pr.number,
    title: pr.title,
    branch: pr.branch,
    author: pr.author || null,
    state: pr.state,
    html_url: pr.html_url,
    created_at: pr.created_at,
    ci_started_at: pr.ci_started_at || null,
    ci_completed_at: pr.ci_completed_at || null,
    merged_at: pr.merged_at || null,
    partial_ci_history: pr.partialCiHistory,
    time_to_ci_start_seconds: pr.timeToCiStartInSeconds || null,
    ci_duration_seconds: pr.ciDurationInSeconds || null,
    time_to_merge_seconds: pr.timeToMergeInSeconds || null,
    merge_lead_time_seconds: pr.mergeLeadTimeInSeconds || null,
    workflow_count: pr.workflowCount,
    successful_workflow_count: pr.successfulWorkflowCount,
    conclusion: pr.conclusion || null,
  }));

  const { error } = await supabase
    .from('pr_metrics')
    .upsert(prRows, { onConflict: 'repo_id,pr_number' });

  if (error) {
    console.error(`  [Supabase] Error inserting PR metrics: ${error.message}`);
  }
}

export interface CollectionState {
  backfillCursor: string | null;
  historyComplete: boolean;
  latestDate: string | null;
  retentionDays: number;
  lastUpdated: string | null;
}

export async function readCollectionState(repo: string): Promise<CollectionState | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return null;

  const { data, error } = await supabase
    .from('collection_state')
    .select('*')
    .eq('repo_id', repoId)
    .single();

  if (error) {
    if (error.code !== 'PGRST116') {
      console.error(`  [Supabase] Error reading collection state: ${error.message}`);
    }
    return null;
  }

  return {
    backfillCursor: data.backfill_cursor,
    historyComplete: data.history_complete ?? false,
    latestDate: data.latest_date,
    retentionDays: data.retention_days ?? 90,
    lastUpdated: data.last_updated,
  };
}

export async function writeCollectionState(
  repo: string,
  state: CollectionState,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return;

  const { error } = await supabase
    .from('collection_state')
    .upsert({
      repo_id: repoId,
      backfill_cursor: state.backfillCursor,
      history_complete: state.historyComplete,
      latest_date: state.latestDate,
      retention_days: state.retentionDays,
      last_updated: state.lastUpdated ?? new Date().toISOString(),
    }, { onConflict: 'repo_id' });

  if (error) {
    console.error(`  [Supabase] Error writing collection state: ${error.message}`);
  }
}

export async function getCollectedDatesFromSupabase(repo: string): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return [];

  const { data, error } = await supabase
    .rpc('get_distinct_dates', { p_repo_id: repoId });

  if (error) {
    console.error(`  [Supabase] Error fetching collected dates: ${error.message}`);
    return [];
  }

  return (data || []).map((row: { date: string }) => row.date);
}
