/**
 * Supabase storage adapter for ETL pipeline.
 * Writes runs, jobs, and PR metrics to Supabase database.
 */

import { createClient } from '@supabase/supabase-js';
import type { GitHubApiPayload } from '../../src/lib/types.ts';

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
  githubPayload?: GitHubApiPayload;
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
  githubPayload?: GitHubApiPayload;
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

export type PullRequestResolutionStatus = 'resolved' | 'not_found' | 'failed' | 'rate_limited';

export interface PullRequestResolutionCacheEntry {
  head_sha: string;
  pr_number?: number | null;
  source?: string;
  status?: PullRequestResolutionStatus;
  error_message?: string | null;
}

export interface PullRequestResolutionCacheRecord {
  head_sha: string;
  pr_number: number | null;
  source: string;
  status: PullRequestResolutionStatus;
  error_message: string | null;
}

let cachedClient: ReturnType<typeof createClient> | null = null;
const SUPABASE_PAGE_SIZE = 1000;
const PR_RESOLUTION_SOURCE_PRIORITY: Record<string, number> = {
  run_payload: 1,
  workflow_run: 1,
  search_api: 2,
  commits_api: 3,
};

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

const RUN_UPSERT_BATCH_SIZE = readPositiveIntegerEnv('RUN_UPSERT_BATCH_SIZE', 200);
const JOB_UPSERT_BATCH_SIZE = readPositiveIntegerEnv('JOB_UPSERT_BATCH_SIZE', 500);
const CACHE_UPSERT_BATCH_SIZE = readPositiveIntegerEnv('CACHE_UPSERT_BATCH_SIZE', 100);
const PR_METRIC_UPSERT_BATCH_SIZE = readPositiveIntegerEnv('PR_METRIC_UPSERT_BATCH_SIZE', 100);
const PR_WORKFLOW_UPSERT_BATCH_SIZE = readPositiveIntegerEnv('PR_WORKFLOW_UPSERT_BATCH_SIZE', 500);

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

function getPrResolutionStatus(entry: PullRequestResolutionCacheEntry): PullRequestResolutionStatus {
  if (entry.status) return entry.status;
  return typeof entry.pr_number === 'number' ? 'resolved' : 'failed';
}

function isPrResolutionStatus(value: unknown): value is PullRequestResolutionStatus {
  return value === 'resolved' || value === 'not_found' || value === 'failed' || value === 'rate_limited';
}

function shouldWritePrResolutionCacheEntry(
  incoming: PullRequestResolutionCacheEntry,
  existing?: { source: string; status: PullRequestResolutionStatus; error_message: string | null },
): boolean {
  if (!existing) return true;

  const incomingStatus = getPrResolutionStatus(incoming);
  if (existing.status === 'resolved') {
    return (
      incomingStatus === 'resolved' &&
      getPrResolutionSourcePriority(incoming.source) >= getPrResolutionSourcePriority(existing.source)
    );
  }

  if (incomingStatus === 'resolved' || incomingStatus === 'not_found') return true;
  if (existing.status === 'not_found') return false;

  // Retryable existing (failed/rate_limited) — always allow new attempt to refresh
  return true;
}

function requireSupabaseForWrite(repo: string) {
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error(`Supabase is not configured for ${repo}`);
  }

  return supabase;
}

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  if (size <= 0) {
    throw new Error('Chunk size must be greater than 0');
  }

  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
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

async function requireRepoIdForWrite(repo: string): Promise<number> {
  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) {
    throw new Error(`Failed to ensure repository ${repo} in Supabase`);
  }

  return repoId;
}

export async function writeRunsToSupabase(repo: string, runs: Run[], date: string): Promise<void> {
  if (runs.length === 0) return;

  const supabase = requireSupabaseForWrite(repo);
  const repoId = await requireRepoIdForWrite(repo);

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
    github_payload: run.githubPayload ?? null,
    date,
  }));

  for (const batch of chunkArray(runRows, RUN_UPSERT_BATCH_SIZE)) {
    const { error: runError } = await supabase
      .from('runs')
      .upsert(batch, { onConflict: 'id' });

    if (runError) {
      throw new Error(`Failed to insert runs for ${repo} into Supabase: ${runError.message}`);
    }
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
    github_payload: GitHubApiPayload | null;
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
          github_payload: job.githubPayload ?? null,
        });
      }
    }
  }

  for (const batch of chunkArray(jobRows, JOB_UPSERT_BATCH_SIZE)) {
    const { error: jobError } = await supabase
      .from('jobs')
      .upsert(batch, { onConflict: 'id' });

    if (jobError) {
      throw new Error(`Failed to insert jobs for ${repo} into Supabase: ${jobError.message}`);
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
): Promise<Map<string, PullRequestResolutionCacheRecord>> {
  const supabase = getSupabase();
  if (!supabase || shas.length === 0) return new Map();

  const [owner, repoName] = repo.split('/');
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return new Map();

  const cached = new Map<string, PullRequestResolutionCacheRecord>();
  const uniqueShas = Array.from(new Set(shas));

  for (const batch of chunkArray(uniqueShas, CACHE_UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('pr_resolution_cache')
      .select('head_sha, pr_number, source, status, error_message')
      .eq('repo_id', repoId)
      .in('head_sha', batch);

    if (error) {
      console.error(`  [Supabase] Error reading PR resolution cache: ${error.message}`);
      continue;
    }

    for (const row of data || []) {
      if (typeof row.head_sha === 'string') {
        const prNumber = typeof row.pr_number === 'number' ? row.pr_number : null;
        const status = isPrResolutionStatus(row.status)
          ? row.status
          : prNumber === null
            ? 'failed'
            : 'resolved';

        cached.set(row.head_sha, {
          head_sha: row.head_sha,
          pr_number: prNumber,
          source: typeof row.source === 'string' ? row.source : 'commits_api',
          status,
          error_message: typeof row.error_message === 'string' ? row.error_message : null,
        });
      }
    }
  }

  return cached;
}

export async function writePullRequestResolutionCacheToSupabase(
  repo: string,
  entries: PullRequestResolutionCacheEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const supabase = requireSupabaseForWrite(repo);
  const repoId = await requireRepoIdForWrite(repo);

  const entriesBySha = new Map<string, PullRequestResolutionCacheEntry>();
  for (const entry of entries) {
    const existing = entriesBySha.get(entry.head_sha);
    const incomingStatus = getPrResolutionStatus(entry);
    const existingStatus = existing ? getPrResolutionStatus(existing) : undefined;
    if (
      !existing ||
      (incomingStatus === 'resolved' &&
        (existingStatus !== 'resolved' ||
          getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source))) ||
      (existingStatus !== 'resolved' &&
        getPrResolutionSourcePriority(entry.source) >= getPrResolutionSourcePriority(existing.source))
    ) {
      entriesBySha.set(entry.head_sha, entry);
    }
  }
  const uniqueEntries = Array.from(entriesBySha.values());
  const existingEntries = new Map<string, { source: string; status: PullRequestResolutionStatus; error_message: string | null }>();
  const uniqueShas = uniqueEntries.map((entry) => entry.head_sha);

  for (const batch of chunkArray(uniqueShas, CACHE_UPSERT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('pr_resolution_cache')
      .select('head_sha, pr_number, source, status, error_message')
      .eq('repo_id', repoId)
      .in('head_sha', batch);

    if (error) {
      console.error(`  [Supabase] Error checking PR resolution cache priority: ${error.message}`);
      continue;
    }

    for (const row of data || []) {
      if (typeof row.head_sha === 'string' && typeof row.source === 'string') {
        existingEntries.set(row.head_sha, {
          source: row.source,
          status: isPrResolutionStatus(row.status)
            ? row.status
            : typeof row.pr_number === 'number'
              ? 'resolved'
              : 'failed',
          error_message: typeof row.error_message === 'string' ? row.error_message : null,
        });
      }
    }
  }

  const rows = uniqueEntries
    .filter((entry) => {
      const existing = existingEntries.get(entry.head_sha);
      return shouldWritePrResolutionCacheEntry(entry, existing);
    })
    .map((entry) => {
      const status = getPrResolutionStatus(entry);
      const now = new Date().toISOString();

      return {
        repo_id: repoId,
        head_sha: entry.head_sha,
        pr_number: entry.pr_number ?? null,
        source: entry.source ?? 'commits_api',
        status,
        error_message: entry.error_message ?? null,
        attempted_at: now,
        ...(status === 'resolved' ? { resolved_at: now } : {}),
      };
    });

  if (rows.length === 0) return;

  for (const batch of chunkArray(rows, CACHE_UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('pr_resolution_cache')
      .upsert(batch, { onConflict: 'repo_id,head_sha' });

    if (error) {
      throw new Error(`Failed to write PR resolution cache for ${repo} into Supabase: ${error.message}`);
    }
  }
}

export async function writePrWorkflowsToSupabase(repo: string, prWorkflows: Map<number, number[]>): Promise<void> {
  if (prWorkflows.size === 0) return;

  const supabase = requireSupabaseForWrite(repo);
  const repoId = await requireRepoIdForWrite(repo);

  const prNumberToId = new Map<number, number>();

  for (const batch of chunkArray(Array.from(prWorkflows.keys()), PR_METRIC_UPSERT_BATCH_SIZE)) {
    const { data: prMetrics, error: lookupError } = await supabase
      .from('pr_metrics')
      .select('id, pr_number')
      .eq('repo_id', repoId)
      .in('pr_number', batch);

    if (lookupError) {
      throw new Error(`Failed to look up PR metric IDs for ${repo} in Supabase: ${lookupError.message}`);
    }

    for (const row of prMetrics || []) {
      prNumberToId.set(row.pr_number, row.id);
    }
  }

  const workflowRows: { pr_metric_id: number; run_id: number }[] = [];
  for (const [prNumber, runIds] of prWorkflows.entries()) {
    const prMetricId = prNumberToId.get(prNumber);
    if (!prMetricId) continue;
    for (const runId of runIds) {
      workflowRows.push({ pr_metric_id: prMetricId, run_id: runId });
    }
  }

  if (workflowRows.length === 0) return;

  for (const batch of chunkArray(workflowRows, PR_WORKFLOW_UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('pr_workflows')
      .upsert(batch, { onConflict: 'pr_metric_id,run_id' });

    if (error) {
      throw new Error(`Failed to insert PR workflows for ${repo} into Supabase: ${error.message}`);
    }
  }
}

export async function writePrMetricsToSupabase(repo: string, prs: PrMetricsSummary[]): Promise<void> {
  if (prs.length === 0) return;

  const supabase = requireSupabaseForWrite(repo);
  const repoId = await requireRepoIdForWrite(repo);

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

  for (const batch of chunkArray(prRows, PR_METRIC_UPSERT_BATCH_SIZE)) {
    const { error } = await supabase
      .from('pr_metrics')
      .upsert(batch, { onConflict: 'repo_id,pr_number' });

    if (error) {
      throw new Error(`Failed to insert PR metrics for ${repo} into Supabase: ${error.message}`);
    }
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
  const supabase = requireSupabaseForWrite(repo);

  const repoId = await requireRepoIdForWrite(repo);

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
    throw new Error(`Failed to write collection state for ${repo} into Supabase: ${error.message}`);
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

export interface EtlFreshnessReport {
  latestPrRunCreatedAt: string | null;
  latestPrMetricCreatedAt: string | null;
  lagInSeconds: number | null;
  isStale: boolean;
}

export function formatFreshnessReport(report: EtlFreshnessReport, repo: string): string {
  if (report.isStale) {
    const lagDisplay = report.lagInSeconds !== null ? `${Math.round(report.lagInSeconds / 3600)}h` : 'infinite';
    return `ETL freshness: ${repo} pr_metrics lag behind PR runs by ${lagDisplay} (runs: ${report.latestPrRunCreatedAt}, metrics: ${report.latestPrMetricCreatedAt})`;
  }
  if (report.latestPrRunCreatedAt && report.latestPrMetricCreatedAt) {
    return `ETL freshness: ${repo} pr_metrics in sync (lag: ${Math.round(report.lagInSeconds! / 60)}min)`;
  }
  return `ETL freshness: ${repo} PR runs=${report.latestPrRunCreatedAt ?? 'none'}, metrics=${report.latestPrMetricCreatedAt ?? 'none'}`;
}

export async function checkEtlFreshness(repo: string, staleThresholdSeconds = 86400): Promise<EtlFreshnessReport | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const parts = repo.split('/');
  if (parts.length !== 2) {
    console.error(`Invalid repo format for freshness check: ${repo}. Expected owner/repo`);
    return null;
  }
  const [owner, repoName] = parts;
  const repoId = await ensureRepo(owner, repoName);
  if (!repoId) return null;

  const prEvents = ['pull_request', 'pull_request_target', 'pull_request_review'];
  const [runsResult, metricsResult] = await Promise.all([
    supabase
      .from('runs')
      .select('created_at')
      .eq('repo_id', repoId)
      .in('event', prEvents)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from('pr_metrics')
      .select('created_at')
      .eq('repo_id', repoId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (runsResult.error && runsResult.error.code !== 'PGRST116') {
    console.error(`  [Supabase] Error fetching latest run for freshness check: ${runsResult.error.message}`);
  }
  if (metricsResult.error && metricsResult.error.code !== 'PGRST116') {
    console.error(`  [Supabase] Error fetching latest metric for freshness check: ${metricsResult.error.message}`);
  }

  const latestPrRunCreatedAt = runsResult.data?.created_at ?? null;
  const latestPrMetricCreatedAt = metricsResult.data?.created_at ?? null;

  let lagInSeconds: number | null = null;
  if (latestPrRunCreatedAt && latestPrMetricCreatedAt) {
    lagInSeconds = (new Date(latestPrRunCreatedAt).getTime() - new Date(latestPrMetricCreatedAt).getTime()) / 1000;
  }

  return {
    latestPrRunCreatedAt,
    latestPrMetricCreatedAt,
    lagInSeconds,
    isStale: (latestPrRunCreatedAt !== null && latestPrMetricCreatedAt === null) || (lagInSeconds !== null && lagInSeconds > staleThresholdSeconds),
  };
}
