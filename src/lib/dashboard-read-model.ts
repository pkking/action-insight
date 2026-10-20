import 'server-only';
import { cache } from 'react';

import { getTrackedRepoOptions, type RepoOption } from './server-homepage-data';
import { getDatabaseClient, query } from './db';
import { pgPlaceholders, pgTuplePlaceholders } from './pg-utils';
import {
  computePrTimingParts,
  computeStats,
  type MetricStats,
} from './dashboard-metrics';

// ponytail: one internal query module is the seam (ADR-008, spec §6).
// Callers never assemble SQL or recompute metrics.

export type DashboardTab = 'pr' | 'cost' | 'workflow' | 'job' | 'queue';

export type DashboardQuery = {
  tab: DashboardTab;
  startDate: string; // inclusive UTC yyyy-mm-dd
  endDate: string; // inclusive UTC yyyy-mm-dd
  repoKey?: string; // absent = all tracked repositories
  resourceModel?: string; // queue secondary filter only
  page: number;
  pageSize: number;
  observationLimit: number;
};

export type DashboardQuality = {
  invalidTimingSamples: number;
  unknownResourceSamples: number;
  partialHistorySamples: number;
  legacyFallbackSamples: number;
};

export type DashboardResult<TCards, TSeries, TRow> = {
  cards: TCards;
  series: TSeries[];
  rows: TRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  displayedObservationCount: number;
  truncated: boolean;
  quality: DashboardQuality;
};

// Discriminated union keyed by the active tab so the shell can narrow the
// result without casts (spec §6: one seam dispatches by tab).
export type DashboardReadResult =
  | PrDashboardResult
  | CostDashboardResult
  | WorkflowDashboardResult
  | JobDashboardResult
  | QueueDashboardResult;

// ---- PR tab types -------------------------------------------------------

export type PrCardSet = {
  endToEnd: MetricStats;
  ciRuntime: MetricStats;
  review: MetricStats;
  forcedMergeRate: number; // 0-100
  mergedPrCount: number;
  eligibleForcedMergeCount: number;
};

export type PrSeriesPoint = {
  date: string; // workflow attempt created_at, used as the chart time anchor
  prNumber: number;
  repoKey: string;
  ciRuntime?: number;
  conclusion: string | null;
  pendingJobs?: number;
  runningJobs?: number;
};

export type DailyPrCountPoint = { date: string; count: number };

export type PrTableRow = {
  repoKey: string;
  prNumber: number;
  title: string;
  htmlUrl: string;
  ciRuntime?: number;
  review?: number;
  mergedAt: string;
  mergeState: string;
  forcedMerge: boolean;
  partialCiHistory: boolean;
};

export type PrDashboardResult = DashboardResult<PrCardSet, PrSeriesPoint, PrTableRow> & {
  tab: 'pr';
  dailyCounts?: DailyPrCountPoint[];
};

// ---- Cost tab types (spec §5.2) ----------------------------------------
// ponytail: Machine-Hours come from attempt-scoped workflow_jobs joined to
// workflow_attempts (ADR-008, spec §6). The "per merged PR" denominator is the
// only pr_metrics touch — a count-only join, never PR timing.

export type CostCardSet = {
  totalMachineHours: number;
  machineHoursPerMergedPr?: number; // undefined when no eligible merged PR
  topRepo?: { repoKey: string; machineHours: number };
  topWorkflow?: { workflowFile: string; machineHours: number }; // one repo only
  dailyAverageMachineHours: number; // total / days in range
  contributingCount: number; // repo count (all) or merged-PR count (one repo)
};

export type CostSeriesPoint = {
  date: string; // run date (yyyy-mm-dd)
  repoKey: string;
  machineHours: number;
};

export type CostTableRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  resourceModel: string;
  avgWorkflowTotalDuration?: number; // avg over distinct attempts in group
  attemptCount: number; // distinct attempts contributing jobs to this group
  successCount: number; // terminal attempts with conclusion='success'
  failureRate: number; // failures / terminal attempts (0-100)
  machineHours: number;
  shareOfTotal: number; // 0-100
  unknownCostCount: number; // jobs without attributable Machine-Hours
};

export type CostDashboardResult = DashboardResult<CostCardSet, CostSeriesPoint, CostTableRow> & {
  tab: 'cost';
};

// ---- Workflow tab types (spec §5.3) ------------------------------------
// ponytail: cards + daily chart are attempt-scoped (workflow_attempts); the
// table groups jobs by resource_model for Machine-Hours, same grouping key as
// Cost. Drill-down is lazy and bounded separately.

export type WorkflowCardSet = {
  totalAttempts: number;
  p50TotalDuration?: number; // successful attempts only (spec §4)
  p90TotalDuration?: number;
  successRate: number; // success / terminal attempts (0-100)
  contributingRepoCount: number;
  topWorkflow?: { workflowFile: string; machineHours: number }; // one repo
};

export type WorkflowSeriesPoint = {
  date: string; // run date (yyyy-mm-dd)
  key: string; // repoKey (all) or workflowFile (one repo)
  attempts: number;
};

export type WorkflowTableRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  resourceModel: string;
  avgWorkflowTotalDuration?: number;
  attemptCount: number;
  successCount: number;
  failureRate: number;
  machineHours: number;
  unknownCostCount: number;
  latestDate: string;
};

export type WorkflowDashboardResult = DashboardResult<
  WorkflowCardSet,
  WorkflowSeriesPoint,
  WorkflowTableRow
> & {
  tab: 'workflow';
};

// ---- Job tab types (spec §5.4) ------------------------------------------
// ponytail: Job/Queue share a richer job-row population (job-level queue +
// total + runtime). Job grouping adds job_name to the Workflow key.

export type JobCardSet = {
  totalJobs: number;
  p50TotalDuration?: number; // successful Job Total Duration (spec §4)
  p90TotalDuration?: number;
  successRate: number; // success / terminal jobs (0-100)
  contributingRepoCount: number;
  topJob?: { jobName: string; machineHours: number }; // one repo
};

export type JobSeriesPoint = {
  date: string;
  key: string; // repoKey (all) or jobName (one repo)
  jobs: number;
};

export type JobTableRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  jobName: string;
  resourceModel: string;
  avgJobTotalDuration?: number;
  executionCount: number; // job instances in the group
  successCount: number;
  failureRate: number;
  machineHours: number;
  unknownCostCount: number;
  latestDate: string;
};

export type JobDashboardResult = DashboardResult<JobCardSet, JobSeriesPoint, JobTableRow> & {
  tab: 'job';
};

// ---- Queue tab types (spec §5.5) ---------------------------------------

export type QueueCardSet = {
  p50QueueDuration?: number; // valid queue samples only
  p90QueueDuration?: number;
  maxQueueDuration?: number; // longest valid queue sample
  shareOverOneHour: number; // valid samples > 3600s ÷ valid samples (0-100)
  distinctResourceModelCount: number;
};

export type QueueSeriesPoint = {
  date: string;
  resourceModel: string;
  p90: number; // daily P90 queue duration (spec §5.5)
};

export type QueueTableRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  jobName: string;
  resourceModel: string;
  queueP90?: number;
  executionCount: number;
  successRate: number; // success / terminal (0-100)
  latestDate: string;
};

export type QueueDashboardResult = DashboardResult<
  QueueCardSet,
  QueueSeriesPoint,
  QueueTableRow
> & {
  tab: 'queue';
};

// ---- Query input validation --------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABS: readonly DashboardTab[] = ['pr', 'cost', 'workflow', 'job', 'queue'];

export function validateDashboardQuery(input: DashboardQuery): void {
  if (!TABS.includes(input.tab)) {
    throw new Error(`Invalid dashboard tab: ${input.tab}`);
  }
  if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate)) {
    throw new Error('startDate and endDate must be yyyy-mm-dd');
  }
  if (input.startDate > input.endDate) {
    throw new Error('startDate must not be after endDate');
  }
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new Error('page must be a positive integer');
  }
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1) {
    throw new Error('pageSize must be a positive integer');
  }
  if (!Number.isInteger(input.observationLimit) || input.observationLimit < 1) {
    throw new Error('observationLimit must be a positive integer');
  }
}

// ---- Repository resolution ----------------------------------------------

type RepoRow = { id: number; key: string };

async function resolveRepoRows(
  options: RepoOption[],
  repoKey?: string,
): Promise<RepoRow[]> {
  if (!repoKey) {
    // All tracked repositories. Resolve ids in one query.
    if (options.length === 0) return [];
    const placeholders = pgTuplePlaceholders(options.length);
    const { rows } = await query(
      `SELECT id, owner, repo FROM repos WHERE (owner, repo) IN (${placeholders})`,
      options.flatMap((o) => [o.owner, o.repo]),
    );
    return rows.map((r) => ({ id: Number(r.id), key: `${r.owner}/${r.repo}` }));
  }
  const target = options.find((o) => o.key === repoKey);
  if (!target) {
    throw new Error(`Repository not tracked: ${repoKey}`);
  }
  const { rows } = await query(
    'SELECT id FROM repos WHERE owner = $1 AND repo = $2',
    [target.owner, target.repo],
  );
  if (rows.length === 0) {
    throw new Error(`Repository not found in database: ${repoKey}`);
  }
  return [{ id: Number(rows[0].id), key: repoKey }];
}

// ---- PR tab read model --------------------------------------------------

export type PrMetricRow = {
  repo_id: number;
  pr_number: number;
  title: string;
  html_url: string;
  branch: string;
  author: string | null;
  state: string;
  conclusion: string | null;
  created_at: string;
  ci_started_at: string | null;
  ci_completed_at: string | null;
  merged_at: string | null;
  partial_ci_history: number;
};

/**
 * Fetch the PR tab population: merged PRs whose merged_at falls in the
 * inclusive UTC date window. The PR tab is anchored by merged_at (spec §4).
 */
export async function fetchPrMetricRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<PrMetricRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const { rows } = await client.query(
      `SELECT pm.repo_id, pm.pr_number, pm.title, pm.html_url, pm.branch,
              pm.author, pm.state, pm.conclusion, pm.created_at,
              pm.ci_started_at, pm.ci_completed_at, pm.merged_at,
              pm.partial_ci_history
       FROM pr_metrics pm
       WHERE pm.repo_id IN (${placeholders})
         AND pm.merged_at IS NOT NULL
         AND pm.merged_at >= $${repoRows.length + 1}
         AND pm.merged_at < $${repoRows.length + 2}
       ORDER BY pm.merged_at DESC`,
      [...repoRows.map((r) => r.id), `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`],
    );
    return rows as PrMetricRow[];
  } finally {
    client.release();
  }
}

export async function fetchPrRunSeries(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<PrSeriesPoint[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const { rows } = await client.query(
      `SELECT r.repo_id, pm.pr_number, wa.created_at, wa.runtime_seconds, wa.conclusion
       FROM pr_workflow_attempts pwa
       JOIN pr_metrics pm ON pm.id = pwa.pr_metric_id
       JOIN workflow_attempts wa
         ON wa.run_id = pwa.run_id AND wa.run_attempt = pwa.run_attempt
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id IN (${placeholders})
         AND pm.merged_at >= $${repoRows.length + 1}
         AND pm.merged_at < $${repoRows.length + 2}
       ORDER BY wa.created_at ASC, wa.run_id ASC, wa.run_attempt ASC`,
      [...repoRows.map((r) => r.id), `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`],
    );
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      date: String(row.created_at),
      prNumber: Number(row.pr_number),
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      ciRuntime: row.runtime_seconds == null ? undefined : Number(row.runtime_seconds),
      conclusion: (row.conclusion as string | null) ?? null,
    }));
  } finally {
    client.release();
  }
}

export type PrJobConcurrencyCounts = { pendingJobs: number; runningJobs: number };

/**
 * Pending/running job counts at each series timestamp (ADR-021 pushdown for
 * the PR tab). pending(T) = C(T) − S(T) and running(T) = S(T) − D(T), where
 * C/S/D are cumulative counts of created/started/completed events ≤ T — an
 * event-sweep over the window jobs instead of transferring every job row
 * and rescanning it per series point. Guards mirror the legacy JS semantics
 * under dirty data: a pending cancellation fires at GREATEST(created,
 * started) and a running cancellation at GREATEST(started, completed), so
 * jobs with completed-before-started (or started-before-created) quirks
 * never cancel early and never count forever. Jobs without created_at never
 * count as pending. Event rows sort before markers at equal timestamps
 * (NULLS FIRST) so counts at T include events exactly at T.
 */
export async function fetchPrJobConcurrencyCounts(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
  timestamps: string[],
): Promise<PrJobConcurrencyCounts[]> {
  if (timestamps.length === 0) return [];
  if (repoRows.length === 0) return timestamps.map(() => ({ pendingJobs: 0, runningJobs: 0 }));
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const params: Array<string | number | string[]> = [
      ...repoRows.map((r) => r.id),
      `${startDate}T00:00:00Z`,
      `${endDate}T23:59:59Z`,
      timestamps,
    ];
    // The sweep sorts ~3× window jobs event rows; keep it in memory.
    await client.query('BEGIN');
    let result: { rows: Record<string, unknown>[] };
    try {
      await client.query("SET LOCAL work_mem = '128MB'");
      result = await client.query(
        `WITH jobs AS (
             SELECT wj.created_at, wj.started_at, wj.completed_at
               FROM pr_workflow_attempts pwa
               JOIN pr_metrics pm ON pm.id = pwa.pr_metric_id
               JOIN workflow_jobs wj
                 ON wj.run_id = pwa.run_id AND wj.run_attempt = pwa.run_attempt
               JOIN runs r ON r.id = wj.run_id
              WHERE r.repo_id IN (${placeholders})
                AND pm.merged_at >= $${repoRows.length + 1}
                AND pm.merged_at < $${repoRows.length + 2}
         ), event_rows AS (
             SELECT created_at::timestamptz AS ts, 1 AS dc, 0 AS dsp, 0 AS dsr, 0 AS dd, NULL::int AS i
               FROM jobs WHERE created_at IS NOT NULL
             UNION ALL
             SELECT GREATEST(created_at::timestamptz, started_at::timestamptz), 0, 1, 0, 0, NULL
               FROM jobs WHERE started_at IS NOT NULL AND created_at IS NOT NULL
             UNION ALL
             SELECT started_at::timestamptz, 0, 0, 1, 0, NULL
               FROM jobs WHERE started_at IS NOT NULL
             UNION ALL
             SELECT GREATEST(started_at::timestamptz, completed_at::timestamptz), 0, 0, 0, 1, NULL
               FROM jobs WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
             UNION ALL
             SELECT t, 0, 0, 0, 0, i
               FROM unnest($${repoRows.length + 3}::timestamptz[]) WITH ORDINALITY AS u(t, i)
         ), swept AS (
             SELECT i,
                    SUM(dc) OVER w AS c,
                    SUM(dsp) OVER w AS sp,
                    SUM(dsr) OVER w AS sr,
                    SUM(dd) OVER w AS d
               FROM event_rows
             WINDOW w AS (ORDER BY ts, i NULLS FIRST ROWS UNBOUNDED PRECEDING)
         )
         SELECT i, GREATEST(c - sp, 0)::int AS pending_jobs,
                GREATEST(sr - d, 0)::int AS running_jobs
           FROM swept
          WHERE i IS NOT NULL
          ORDER BY i`,
        params,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    const byIndex = new Map(
      result.rows.map((row) => [Number(row.i), {
        pendingJobs: Number(row.pending_jobs),
        runningJobs: Number(row.running_jobs),
      }]),
    );
    return timestamps.map((_, index) => byIndex.get(index + 1) ?? { pendingJobs: 0, runningJobs: 0 });
  } finally {
    client.release();
  }
}

type EnrichedPr = PrMetricRow & {
  repoKey: string;
  timing: ReturnType<typeof computePrTimingParts>;
};

export function buildPrCards(rows: EnrichedPr[]): PrCardSet {
  const e2eSamples: number[] = [];
  const ciSamples: number[] = [];
  const reviewSamples: number[] = [];
  let forcedEligible = 0;
  let forcedMerged = 0;

  for (const row of rows) {
    const { ciRuntime, review, endToEnd, forcedMerge } = row.timing;
    if (endToEnd !== undefined) {
      e2eSamples.push(endToEnd);
    }
    if (ciRuntime !== undefined) ciSamples.push(ciRuntime);
    if (review !== undefined) reviewSamples.push(review);
    // Forced Merge Indicator requires both merged_at and ci_completed_at.
    if (row.merged_at && row.ci_completed_at) {
      forcedEligible += 1;
      if (forcedMerge) forcedMerged += 1;
    }
  }

  return {
    endToEnd: computeStats(e2eSamples),
    ciRuntime: computeStats(ciSamples),
    review: computeStats(reviewSamples),
    forcedMergeRate: forcedEligible > 0 ? (forcedMerged / forcedEligible) * 100 : 0,
    mergedPrCount: rows.length,
    eligibleForcedMergeCount: forcedEligible,
  };
}

export function buildEnrichedRows(
  rows: PrMetricRow[],
  repoRows: RepoRow[],
): EnrichedPr[] {
  const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
  return rows.map((row) => ({
    ...row,
    repoKey: idToKey.get(row.repo_id) ?? 'unknown',
    timing: computePrTimingParts(row),
  }));
}

/**
 * Pure transformation from the full filtered PR population to the bounded
 * dashboard result: cards over the full population, chart series + table
 * rows over the newest `observationLimit` observations (spec §3, §6).
 */
export function buildPrDashboardResult(
  enriched: EnrichedPr[],
  runSeries: PrSeriesPoint[],
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
  jobCounts: PrJobConcurrencyCounts[] = [],
): PrDashboardResult {
  const cards = buildPrCards(enriched);

  const sorted = [...enriched].sort((a, b) =>
    (b.merged_at ?? '').localeCompare(a.merged_at ?? ''),
  );
  const observations = sorted.slice(0, query.observationLimit);
  const truncated = sorted.length > query.observationLimit;

  // Pending/running counts arrive from the SQL event-sweep, aligned by
  // index with the capped series points (ADR-021).
  const series = runSeries.slice(0, query.observationLimit).map((run, index) => ({
    ...run,
    pendingJobs: jobCounts[index]?.pendingJobs ?? 0,
    runningJobs: jobCounts[index]?.runningJobs ?? 0,
  }));
  const dailyCounts = new Map<string, number>();
  for (const row of enriched) {
    const date = (row.merged_at ?? '').slice(0, 10);
    if (date) dailyCounts.set(date, (dailyCounts.get(date) ?? 0) + 1);
  }

  const rows: PrTableRow[] = observations.map((row) => ({
    repoKey: row.repoKey,
    prNumber: row.pr_number,
    title: row.title,
    htmlUrl: row.html_url,
    ciRuntime: row.timing.ciRuntime,
    review: row.timing.review,
    mergedAt: row.merged_at ?? '',
    mergeState: row.state,
    forcedMerge: row.timing.forcedMerge,
    partialCiHistory: Boolean(row.partial_ci_history),
  }));

  const totalRows = rows.length;
  const pageStart = (query.page - 1) * query.pageSize;
  const pagedRows = rows.slice(pageStart, pageStart + query.pageSize);

  const invalidTimingSamples = enriched.filter((r) => r.timing.invalidTiming).length;
  const partialHistorySamples = enriched.filter((r) =>
    Boolean(r.partial_ci_history),
  ).length;

  return {
    tab: 'pr',
    cards,
    series,
    dailyCounts: [...dailyCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, count]) => ({ date, count })),
    rows: pagedRows,
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    displayedObservationCount: observations.length,
    truncated,
    quality: {
      invalidTimingSamples,
      unknownResourceSamples: 0,
      partialHistorySamples,
      legacyFallbackSamples: 0,
    },
  };
}

const DEFAULT_PR_PAGE_SIZE = 20;
const DEFAULT_OBSERVATION_LIMIT = 500;

// ---- Cost tab read model (spec §5.2) -----------------------------------

export type CostBreakdownSlice = {
  label: string;
  machineHours: number;
};

/**
 * Count distinct merged PRs (pr_metrics.merged_at IS NOT NULL) that have at
 * least one attributable job (positive Resource Count + valid Job Runtime)
 * whose run falls in the same filtered window. Count-only join — no PR
 * timing is read (the single pr_metrics touch for the "per merged PR" card).
 */
/** Exact Machine-Hour allocation for one workflow, grouped by resource model. */
export async function fetchCostWorkflowResourceBreakdown(
  repoId: number,
  startDate: string,
  endDate: string,
  workflowFile: string,
  workflowRef: string | null,
): Promise<CostBreakdownSlice[]> {
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT COALESCE(wj.resource_model, 'unknown') AS label,
              SUM(wj.runtime_seconds * wj.resource_count / 3600.0) AS machine_hours
       FROM workflow_jobs wj
       JOIN workflow_attempts wa ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id = $1 AND r.date >= $2 AND r.date <= $3
         AND wa.tracked = 1
         AND COALESCE(wa.workflow_file, '') = $4
         AND COALESCE(wa.workflow_ref, '') = $5
         AND wj.runtime_seconds IS NOT NULL AND wj.runtime_seconds >= 0
         AND wj.resource_count IS NOT NULL AND wj.resource_count > 0
       GROUP BY COALESCE(wj.resource_model, 'unknown')
       ORDER BY machine_hours DESC, label ASC`,
      [repoId, startDate, endDate, workflowFile, workflowRef ?? ''],
    );
    return rows.map((row) => ({
      label: String(row.label),
      machineHours: Number(row.machine_hours),
    }));
  } finally {
    client.release();
  }
}

/**
 * Exact Machine-Hour allocation for one resource model across all tracked
 * repositories, grouped by repository and workflow so same-named workflows
 * remain distinct.
 */
export async function fetchCostResourceWorkflowBreakdown(
  startDate: string,
  endDate: string,
  resourceModel: string,
): Promise<CostBreakdownSlice[]> {
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT CONCAT(rp.owner, '/', rp.repo, ' / ', COALESCE(wa.workflow_file, 'unknown'),
                     CASE WHEN COALESCE(wa.workflow_ref, '') = '' THEN '' ELSE ' @ ' || wa.workflow_ref END) AS label,
              SUM(wj.runtime_seconds * wj.resource_count / 3600.0) AS machine_hours
       FROM workflow_jobs wj
       JOIN workflow_attempts wa ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
       JOIN runs r ON r.id = wa.run_id
       JOIN repos rp ON rp.id = r.repo_id
       WHERE r.date >= $1 AND r.date <= $2
         AND wa.tracked = 1
         AND COALESCE(wj.resource_model, 'unknown') = $3
         AND wj.runtime_seconds IS NOT NULL AND wj.runtime_seconds >= 0
         AND wj.resource_count IS NOT NULL AND wj.resource_count > 0
       GROUP BY rp.owner, rp.repo, wa.workflow_file, wa.workflow_ref
       ORDER BY machine_hours DESC, label ASC`,
      [startDate, endDate, resourceModel],
    );
    return rows.map((row) => ({
      label: String(row.label),
      machineHours: Number(row.machine_hours),
    }));
  } finally {
    client.release();
  }
}

export async function fetchCostMergedPrCount(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<number> {
  if (repoRows.length === 0) return 0;
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const { rows } = await client.query(
      `SELECT COUNT(DISTINCT pwa.pr_metric_id) AS n
       FROM pr_workflow_attempts pwa
       JOIN pr_metrics pm ON pm.id = pwa.pr_metric_id
       JOIN workflow_attempts wa
         ON wa.run_id = pwa.run_id AND wa.run_attempt = pwa.run_attempt
       JOIN workflow_jobs wj
         ON wj.run_id = wa.run_id AND wj.run_attempt = wa.run_attempt
       JOIN runs r ON r.id = pwa.run_id
       WHERE r.repo_id IN (${placeholders})
         AND r.date >= $${repoRows.length + 1}
         AND r.date <= $${repoRows.length + 2}
         AND wa.tracked = 1
         AND pm.merged_at IS NOT NULL
         AND wj.runtime_seconds IS NOT NULL AND wj.runtime_seconds >= 0
         AND wj.resource_count IS NOT NULL AND wj.resource_count > 0`,
      [...repoRows.map((r) => r.id), startDate, endDate],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    client.release();
  }
}

const TERMINAL_CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
]);

export function buildCostCards(
  groups: WorkflowGroupRow[],
  mergedPrCount: number,
  daysInRange: number,
  oneRepo: boolean,
): CostCardSet {
  let totalMachineHours = 0;
  const repoTotals = new Map<string, number>();
  const wfTotals = new Map<string, number>();

  for (const group of groups) {
    totalMachineHours += group.machineHours;
    repoTotals.set(
      group.repoKey,
      (repoTotals.get(group.repoKey) ?? 0) + group.machineHours,
    );
    // Top workflow only meaningful for a single-repo selection.
    if (oneRepo && group.workflowFile) {
      wfTotals.set(
        group.workflowFile,
        (wfTotals.get(group.workflowFile) ?? 0) + group.machineHours,
      );
    }
  }

  const topRepo = [...repoTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([repoKey, machineHours]) => ({ repoKey, machineHours }))[0];
  const topWorkflow = [...wfTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([workflowFile, machineHours]) => ({ workflowFile, machineHours }))[0];

  const dailyAverageMachineHours =
    daysInRange > 0 ? totalMachineHours / daysInRange : 0;
  const machineHoursPerMergedPr =
    mergedPrCount > 0 ? totalMachineHours / mergedPrCount : undefined;
  // contributingCount: repo count for all-repos; merged-PR count for one repo.
  const contributingCount = oneRepo ? mergedPrCount : repoTotals.size;

  return {
    totalMachineHours,
    machineHoursPerMergedPr,
    topRepo,
    topWorkflow,
    dailyAverageMachineHours,
    contributingCount,
  };
}

/** Inclusive day count between two yyyy-mm-dd dates (UTC). */
export function dayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Pure transformation from the SQL-aggregated groups and daily series to
 * the bounded Cost result: cards over the full population, daily series +
 * grouped table rows over the newest `observationLimit` job-observations
 * (spec §3, §6; ADR-021).
 */
export function buildCostDashboardResult(
  groups: WorkflowGroupRow[],
  dailySeries: CostDailyPoint[],
  cards: CostCardSet,
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
): CostDashboardResult {
  // Table rows: one per SQL-aggregated group (repo, file, ref, model).
  // Sort newest-first by latest job date, then MH.
  const allRows: CostTableRow[] = groups
    .map((g) => buildCostTableRow(g, cards.totalMachineHours))
    .sort((a, b) =>
      b.latestDate.localeCompare(a.latestDate) ||
      b.machineHours - a.machineHours,
    );

  const observations = allRows.slice(0, query.observationLimit);
  const truncated = allRows.length > query.observationLimit;
  const totalRows = observations.length;
  const pageStart = (query.page - 1) * query.pageSize;
  const pagedRows = observations.slice(pageStart, pageStart + query.pageSize);

  // Daily series per repo, capped at the newest `observationLimit`
  // (repo,date) points (spec §3). Daily points are sparse (days × repos),
  // so the cap rarely bites. Newest-first to cap, then ascending for the
  // left-to-right chart axis.
  const series: CostSeriesPoint[] = dailySeries.map((p) => ({
    date: p.date,
    repoKey: p.repoKey,
    machineHours: p.machineHours,
  }));
  series.sort((a, b) => b.date.localeCompare(a.date));
  const boundedSeries = series.slice(0, query.observationLimit);
  boundedSeries.sort((a, b) =>
    a.date === b.date
      ? a.repoKey.localeCompare(b.repoKey)
      : a.date.localeCompare(b.date),
  );

  const unknownResourceSamples = groups.reduce(
    (sum, g) => sum + g.unknownCostCount,
    0,
  );

  return {
    tab: 'cost',
    cards,
    series: boundedSeries,
    rows: pagedRows,
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    displayedObservationCount: observations.length,
    truncated,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

/** Build one table row from a (repo, workflow, ref, model) group. */
function buildCostTableRow(
  g: WorkflowGroupRow,
  totalMachineHours: number,
): CostTableRow & { latestDate: string } {
  return {
    repoKey: g.repoKey,
    workflowFile: g.workflowFile,
    workflowRef: g.workflowRef,
    resourceModel: g.resourceModel,
    avgWorkflowTotalDuration:
      g.avgWorkflowTotalDuration == null
        ? undefined
        : g.avgWorkflowTotalDuration,
    attemptCount: g.attemptCount,
    successCount: g.successCount,
    failureRate:
      g.terminalCount > 0
        ? ((g.terminalCount - g.successCount) / g.terminalCount) * 100
        : 0,
    machineHours: g.machineHours,
    shareOfTotal:
      totalMachineHours > 0
        ? (g.machineHours / totalMachineHours) * 100
        : 0,
    unknownCostCount: g.unknownCostCount,
    latestDate: g.latestDate,
  };
}

// ---- Workflow tab read model (spec §5.3) --------------------------------

export type WorkflowAttemptRow = {
  repoKey: string;
  runId: number;
  runAttempt: number;
  runDate: string; // runs.date — the Workflow tab date anchor
  workflowFile: string | null;
  workflowRef: string | null;
  queueDurationSeconds: number | null;
  runtimeSeconds: number | null;
  totalDurationSeconds: number | null;
  conclusion: string | null;
  status: string;
  createdAt: string | null;
};

/**
 * Fetch tracked workflow_attempts in the filtered repo/date window. The
 * Workflow tab is attempt-scoped: cards + daily chart use this population.
 */
export async function fetchWorkflowAttemptRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<WorkflowAttemptRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const { rows } = await client.query(
      `SELECT r.id AS run_id, r.repo_id, r.date, wa.run_attempt,
              wa.workflow_file, wa.workflow_ref, wa.status, wa.conclusion,
              wa.created_at, wa.queue_duration_seconds, wa.runtime_seconds,
              wa.total_duration_seconds
       FROM workflow_attempts wa
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id IN (${placeholders})
         AND r.date >= $${repoRows.length + 1}
         AND r.date <= $${repoRows.length + 2}
         AND wa.tracked = 1
       ORDER BY r.date DESC, r.id DESC, wa.run_attempt DESC`,
      [...repoRows.map((r) => r.id), startDate, endDate],
    );
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      runDate: String(row.date),
      workflowFile: (row.workflow_file as string | null) ?? null,
      workflowRef: (row.workflow_ref as string | null) ?? null,
      queueDurationSeconds:
        row.queue_duration_seconds == null
          ? null
          : Number(row.queue_duration_seconds),
      runtimeSeconds:
        row.runtime_seconds == null ? null : Number(row.runtime_seconds),
      totalDurationSeconds:
        row.total_duration_seconds == null
          ? null
          : Number(row.total_duration_seconds),
      conclusion: (row.conclusion as string | null) ?? null,
      status: String(row.status),
      createdAt: (row.created_at as string | null) ?? null,
    }));
  } finally {
    client.release();
  }
}

export type WorkflowGroupRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  resourceModel: string;
  machineHours: number;
  unknownCostCount: number;
  attemptCount: number;
  successCount: number;
  terminalCount: number;
  avgWorkflowTotalDuration: number | null;
  latestDate: string;
};

/**
 * SQL-aggregated workflow groups (ADR-021): one row per
 * (repo, workflow_file, workflow_ref, resource_model) with machine-hours,
 * unknown-cost counts, and distinct-attempt stats, instead of transferring
 * every workflow_jobs row (590K+ for a 14-day all-repo window) to Node.
 * Attempt-level stats count DISTINCT (run_id, run_attempt) per group so a
 * many-job attempt is not weighted by its job count.
 */
export async function fetchWorkflowGroupRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<WorkflowGroupRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    // Two-stage hash aggregation (590K job rows → per-group-attempt → per-group)
    // inside a transaction that raises work_mem just for this query: the
    // distinct-attempt rollup otherwise spills its sort to disk (EXPLAIN
    // showed a 2.8MB external merge). SET LOCAL keeps the bump scoped.
    await client.query('BEGIN');
    let result: { rows: Record<string, unknown>[] };
    try {
      await client.query("SET LOCAL work_mem = '64MB'");
      result = await client.query(
        `WITH tracked AS (
             SELECT r.repo_id, r.date, wa.run_id, wa.run_attempt,
                    wa.workflow_file, wa.workflow_ref,
                    wa.conclusion, wa.total_duration_seconds
               FROM workflow_attempts wa
               JOIN runs r ON r.id = wa.run_id
              WHERE r.repo_id IN (${placeholders})
                AND r.date >= $${repoRows.length + 1}
                AND r.date <= $${repoRows.length + 2}
                AND wa.tracked = 1
         ), per_group_attempt AS (
             SELECT t.repo_id, t.date, t.workflow_file, t.workflow_ref,
                    COALESCE(j.resource_model, 'unknown') AS resource_model,
                    t.run_id, t.run_attempt, t.conclusion, t.total_duration_seconds,
                    SUM(CASE WHEN j.runtime_seconds >= 0 AND j.resource_count > 0
                             THEN j.runtime_seconds * j.resource_count / 3600.0
                             ELSE 0 END) AS attempt_mh,
                    COUNT(*) FILTER (WHERE j.runtime_seconds IS NULL OR j.runtime_seconds < 0 OR j.resource_count IS NULL OR j.resource_count <= 0) AS attempt_unknown
               FROM tracked t
               JOIN workflow_jobs j
                 ON j.run_id = t.run_id AND j.run_attempt = t.run_attempt
              GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
         )
         SELECT repo_id, workflow_file, workflow_ref, resource_model,
                COALESCE(SUM(attempt_mh), 0) AS machine_hours,
                SUM(attempt_unknown) AS unknown_cost_count,
                MAX(date) AS latest_date,
                COUNT(*) AS attempt_count,
                COUNT(*) FILTER (WHERE conclusion = 'success') AS success_count,
                COUNT(*) FILTER (WHERE conclusion IN ('success', 'failure', 'cancelled')) AS terminal_count,
                AVG(total_duration_seconds) FILTER (WHERE total_duration_seconds >= 0) AS avg_total_duration
           FROM per_group_attempt
          GROUP BY 1, 2, 3, 4`,
        [...repoRows.map((r) => r.id), startDate, endDate],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    const rows = result.rows;
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      workflowFile: (row.workflow_file as string | null) ?? '',
      workflowRef: (row.workflow_ref as string | null) ?? '',
      resourceModel: String(row.resource_model),
      machineHours: Number(row.machine_hours),
      unknownCostCount: Number(row.unknown_cost_count),
      attemptCount: Number(row.attempt_count),
      successCount: Number(row.success_count),
      terminalCount: Number(row.terminal_count),
      avgWorkflowTotalDuration:
        row.avg_total_duration == null ? null : Number(row.avg_total_duration),
      latestDate: String(row.latest_date),
    }));
  } finally {
    client.release();
  }
}

// ---- Job / Queue / Cost SQL aggregation (ADR-021 follow-up) --------------
// Same pushdown pattern as fetchWorkflowGroupRows: aggregate in SQL, return
// group/stat rows instead of transferring every window job row to Node.

const MH_SQL = `CASE WHEN wj.runtime_seconds >= 0 AND wj.resource_count > 0 THEN wj.runtime_seconds * wj.resource_count / 3600.0 ELSE 0 END`;
const UNKNOWN_COST_SQL = `(wj.runtime_seconds IS NULL OR wj.runtime_seconds < 0 OR wj.resource_count IS NULL OR wj.resource_count <= 0)`;
const TERMINAL_SQL = `(wj.conclusion IN ('success', 'failure', 'cancelled'))`;

function trackedWindowFrom(repoCount: number): string {
  return `FROM workflow_jobs wj
       JOIN workflow_attempts wa
         ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
       JOIN runs r ON r.id = wa.run_id
      WHERE r.repo_id IN (${pgPlaceholders(repoCount)})
        AND r.date >= $${repoCount + 1}
        AND r.date <= $${repoCount + 2}
        AND wa.tracked = 1`;
}

function windowParams(repoRows: RepoRow[], startDate: string, endDate: string): Array<string | number> {
  return [...repoRows.map((r) => r.id), startDate, endDate];
}

export type JobGroupRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  jobName: string;
  resourceModel: string;
  machineHours: number;
  unknownCostCount: number;
  executionCount: number;
  avgJobTotalDuration: number | null;
  successCount: number;
  terminalCount: number;
  latestDate: string;
};

/** Job-grain groups: one row per (repo, file, ref, job_name, model). */
export async function fetchJobGroupRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<JobGroupRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    // work_mem bump scoped to this query (ADR-021): the 5-key hash
    // aggregation over ~590K window rows otherwise spills to disk.
    await client.query('BEGIN');
    let result: { rows: Record<string, unknown>[] };
    try {
      await client.query("SET LOCAL work_mem = '64MB'");
      result = await client.query(
        `SELECT r.repo_id, wa.workflow_file, wa.workflow_ref, wj.name AS job_name,
                COALESCE(wj.resource_model, 'unknown') AS resource_model,
                COUNT(*) AS execution_count,
                SUM(${MH_SQL}) AS machine_hours,
                COUNT(*) FILTER (WHERE ${UNKNOWN_COST_SQL}) AS unknown_cost_count,
                AVG(wj.total_duration_seconds) FILTER (WHERE wj.total_duration_seconds >= 0) AS avg_total_duration,
                COUNT(*) FILTER (WHERE ${TERMINAL_SQL}) AS terminal_count,
                COUNT(*) FILTER (WHERE wj.conclusion = 'success') AS success_count,
                MAX(r.date) AS latest_date
             ${trackedWindowFrom(repoRows.length)}
             GROUP BY 1, 2, 3, 4, 5`,
        windowParams(repoRows, startDate, endDate),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    const rows = result.rows;
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      workflowFile: (row.workflow_file as string | null) ?? '',
      workflowRef: (row.workflow_ref as string | null) ?? '',
      jobName: (row.job_name as string | null) ?? '',
      resourceModel: String(row.resource_model),
      machineHours: Number(row.machine_hours),
      unknownCostCount: Number(row.unknown_cost_count),
      executionCount: Number(row.execution_count),
      avgJobTotalDuration:
        row.avg_total_duration == null ? null : Number(row.avg_total_duration),
      successCount: Number(row.success_count),
      terminalCount: Number(row.terminal_count),
      latestDate: String(row.latest_date),
    }));
  } finally {
    client.release();
  }
}

export type JobPopulationStats = {
  totalJobs: number;
  terminalCount: number;
  successCount: number;
  p50TotalDuration: number | null;
  p90TotalDuration: number | null;
  unknownResourceSamples: number;
};

/**
 * Whole-population job stats for the Job cards. percentile_disc matches the
 * repository's nearest-rank convention (verified: ceil(p*N) position).
 */
export async function fetchJobPopulationStats(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<JobPopulationStats> {
  if (repoRows.length === 0) {
    return { totalJobs: 0, terminalCount: 0, successCount: 0, p50TotalDuration: null, p90TotalDuration: null, unknownResourceSamples: 0 };
  }
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT COUNT(*) AS total_jobs,
              COUNT(*) FILTER (WHERE ${TERMINAL_SQL}) AS terminal_count,
              COUNT(*) FILTER (WHERE wj.conclusion = 'success') AS success_count,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY wj.total_duration_seconds)
                FILTER (WHERE wj.conclusion = 'success' AND wj.total_duration_seconds >= 0) AS p50_total_duration,
              percentile_disc(0.9) WITHIN GROUP (ORDER BY wj.total_duration_seconds)
                FILTER (WHERE wj.conclusion = 'success' AND wj.total_duration_seconds >= 0) AS p90_total_duration,
              COUNT(*) FILTER (WHERE ${UNKNOWN_COST_SQL}) AS unknown_resource_samples
           ${trackedWindowFrom(repoRows.length)}`,
      windowParams(repoRows, startDate, endDate),
    );
    const row = rows[0] ?? {};
    return {
      totalJobs: Number(row.total_jobs),
      terminalCount: Number(row.terminal_count),
      successCount: Number(row.success_count),
      p50TotalDuration: row.p50_total_duration == null ? null : Number(row.p50_total_duration),
      p90TotalDuration: row.p90_total_duration == null ? null : Number(row.p90_total_duration),
      unknownResourceSamples: Number(row.unknown_resource_samples),
    };
  } finally {
    client.release();
  }
}

export type DailyCountPoint = { date: string; key: string; count: number };

/** Daily job counts per repo (all-repos series). */
export async function fetchJobDailyCounts(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<DailyCountPoint[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT r.repo_id, r.date, COUNT(*) AS count
           ${trackedWindowFrom(repoRows.length)}
           GROUP BY 1, 2`,
      windowParams(repoRows, startDate, endDate),
    );
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      date: String(row.date),
      key: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      count: Number(row.count),
    }));
  } finally {
    client.release();
  }
}

/** Daily job counts per job name (single-repo series). */
export async function fetchJobNameDailyCounts(
  repoId: number,
  startDate: string,
  endDate: string,
): Promise<DailyCountPoint[]> {
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT wj.name AS job_name, r.date, COUNT(*) AS count
         FROM workflow_jobs wj
         JOIN workflow_attempts wa
           ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
         JOIN runs r ON r.id = wa.run_id
        WHERE r.repo_id = $1
          AND r.date >= $2
          AND r.date <= $3
          AND wa.tracked = 1
        GROUP BY 1, 2`,
      [repoId, startDate, endDate],
    );
    return rows.map((row) => ({
      date: String(row.date),
      key: (row.job_name as string | null) || '(unknown)',
      count: Number(row.count),
    }));
  } finally {
    client.release();
  }
}

export type QueueGroupRow = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  jobName: string;
  resourceModel: string;
  executionCount: number;
  queueP90: number | null;
  successCount: number;
  terminalCount: number;
  latestDate: string;
};

/** Queue groups: per job-group P90 queue via percentile_disc (nearest-rank). */
export async function fetchQueueGroupRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<QueueGroupRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    // work_mem bump scoped to this query (ADR-021): percentile_disc keeps a
    // sorted transition state per group; the default 4MB spills at this
    // window size.
    await client.query('BEGIN');
    let result: { rows: Record<string, unknown>[] };
    try {
      await client.query("SET LOCAL work_mem = '64MB'");
      result = await client.query(
        `SELECT r.repo_id, wa.workflow_file, wa.workflow_ref, wj.name AS job_name,
                COALESCE(wj.resource_model, 'unknown') AS resource_model,
                COUNT(*) AS execution_count,
                percentile_disc(0.9) WITHIN GROUP (ORDER BY wj.queue_duration_seconds)
                  FILTER (WHERE wj.queue_duration_seconds >= 0) AS queue_p90,
                COUNT(*) FILTER (WHERE ${TERMINAL_SQL}) AS terminal_count,
                COUNT(*) FILTER (WHERE wj.conclusion = 'success') AS success_count,
                MAX(r.date) AS latest_date
             ${trackedWindowFrom(repoRows.length)}
             GROUP BY 1, 2, 3, 4, 5`,
        windowParams(repoRows, startDate, endDate),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    const rows = result.rows;
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      workflowFile: (row.workflow_file as string | null) ?? '',
      workflowRef: (row.workflow_ref as string | null) ?? '',
      jobName: (row.job_name as string | null) ?? '',
      resourceModel: String(row.resource_model),
      executionCount: Number(row.execution_count),
      queueP90: row.queue_p90 == null ? null : Number(row.queue_p90),
      successCount: Number(row.success_count),
      terminalCount: Number(row.terminal_count),
      latestDate: String(row.latest_date),
    }));
  } finally {
    client.release();
  }
}

export type QueuePopulationStats = {
  sampleCount: number;
  p50QueueDuration: number | null;
  p90QueueDuration: number | null;
  maxQueueDuration: number | null;
  overOneHourCount: number;
  invalidTimingSamples: number;
  distinctResourceModelCount: number;
  unknownResourceSamples: number;
};

export async function fetchQueuePopulationStats(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<QueuePopulationStats> {
  if (repoRows.length === 0) {
    return { sampleCount: 0, p50QueueDuration: null, p90QueueDuration: null, maxQueueDuration: null, overOneHourCount: 0, invalidTimingSamples: 0, distinctResourceModelCount: 0, unknownResourceSamples: 0 };
  }
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE wj.queue_duration_seconds >= 0) AS sample_count,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY wj.queue_duration_seconds)
                FILTER (WHERE wj.queue_duration_seconds >= 0) AS p50_queue,
              percentile_disc(0.9) WITHIN GROUP (ORDER BY wj.queue_duration_seconds)
                FILTER (WHERE wj.queue_duration_seconds >= 0) AS p90_queue,
              MAX(wj.queue_duration_seconds) FILTER (WHERE wj.queue_duration_seconds >= 0) AS max_queue,
              COUNT(*) FILTER (WHERE wj.queue_duration_seconds > 3600) AS over_one_hour_count,
              COUNT(*) FILTER (WHERE wj.queue_duration_seconds IS NULL OR wj.queue_duration_seconds < 0) AS invalid_timing_samples,
              COUNT(DISTINCT wj.resource_model) FILTER (WHERE wj.resource_model IS NOT NULL) AS distinct_resource_models,
              COUNT(*) FILTER (WHERE wj.resource_model IS NULL) AS unknown_resource_samples
           ${trackedWindowFrom(repoRows.length)}`,
      windowParams(repoRows, startDate, endDate),
    );
    const row = rows[0] ?? {};
    return {
      sampleCount: Number(row.sample_count),
      p50QueueDuration: row.p50_queue == null ? null : Number(row.p50_queue),
      p90QueueDuration: row.p90_queue == null ? null : Number(row.p90_queue),
      maxQueueDuration: row.max_queue == null ? null : Number(row.max_queue),
      overOneHourCount: Number(row.over_one_hour_count),
      invalidTimingSamples: Number(row.invalid_timing_samples),
      distinctResourceModelCount: Number(row.distinct_resource_models),
      unknownResourceSamples: Number(row.unknown_resource_samples),
    };
  } finally {
    client.release();
  }
}

export type QueueDailyPoint = { date: string; resourceModel: string; p90: number };

/** Daily P90 queue per resource model; optional model filter (series only). */
export async function fetchQueueDailyP90(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
  resourceModel?: string,
): Promise<QueueDailyPoint[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const params = windowParams(repoRows, startDate, endDate);
    const modelClause = resourceModel
      ? ` AND wj.resource_model = $${params.length + 1}`
      : '';
    if (resourceModel) params.push(resourceModel);
    const { rows } = await client.query(
      `SELECT r.date, wj.resource_model,
              percentile_disc(0.9) WITHIN GROUP (ORDER BY wj.queue_duration_seconds) AS p90
           ${trackedWindowFrom(repoRows.length)}
             AND wj.queue_duration_seconds >= 0
             AND wj.resource_model IS NOT NULL${modelClause}
           GROUP BY 1, 2`,
      params,
    );
    return rows.map((row) => ({
      date: String(row.date),
      resourceModel: String(row.resource_model),
      p90: Number(row.p90),
    }));
  } finally {
    client.release();
  }
}

export type CostDailyPoint = { date: string; repoKey: string; machineHours: number };

/** Daily machine-hours per repo for the Cost trend series. A (repo, date)
 *  point exists only when at least one attributable job contributed — days
 *  with unknown-cost jobs only are absent, matching the legacy series. */
export async function fetchCostDailyMachineHours(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<CostDailyPoint[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT r.repo_id, r.date,
              SUM(CASE WHEN wj.runtime_seconds >= 0 AND wj.resource_count > 0
                       THEN wj.runtime_seconds * wj.resource_count / 3600.0 END) AS machine_hours
           ${trackedWindowFrom(repoRows.length)}
           GROUP BY 1, 2
          HAVING COUNT(*) FILTER (WHERE wj.runtime_seconds >= 0 AND wj.resource_count > 0) > 0`,
      windowParams(repoRows, startDate, endDate),
    );
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      date: String(row.date),
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      machineHours: Number(row.machine_hours),
    }));
  } finally {
    client.release();
  }
}

export function buildWorkflowCards(
  attempts: WorkflowAttemptRow[],
  groups: WorkflowGroupRow[],
  oneRepo: boolean,
): WorkflowCardSet {
  const terminal = attempts.filter((a) =>
    a.conclusion ? TERMINAL_CONCLUSIONS.has(a.conclusion) : false,
  );
  const successCount = terminal.filter(
    (a) => a.conclusion === 'success',
  ).length;
  // Percentiles over successful samples only (spec §4).
  const successTotals = attempts
    .filter((a) => a.conclusion === 'success' && a.totalDurationSeconds != null && a.totalDurationSeconds >= 0)
    .map((a) => a.totalDurationSeconds!);
  const stats = computeStats(successTotals);

  const contributingRepoCount = new Set(attempts.map((a) => a.repoKey)).size;

  // Highest-Machine-Hour workflow (one repo only). Derived from SQL-side
  // group aggregates so it reflects attributable cost, the same basis as
  // the table (ADR-021).
  const wfTotals = new Map<string, number>();
  if (oneRepo) {
    for (const group of groups) {
      if (group.workflowFile) {
        wfTotals.set(
          group.workflowFile,
          (wfTotals.get(group.workflowFile) ?? 0) + group.machineHours,
        );
      }
    }
  }
  const topWorkflow = [...wfTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([workflowFile, machineHours]) => ({ workflowFile, machineHours }))[0];

  return {
    totalAttempts: attempts.length,
    p50TotalDuration: stats.sampleCount > 0 ? stats.p50 : undefined,
    p90TotalDuration: stats.sampleCount > 0 ? stats.p90 : undefined,
    successRate:
      terminal.length > 0 ? (successCount / terminal.length) * 100 : 0,
    contributingRepoCount,
    topWorkflow,
  };
}

/**
 * Pure transformation for the Workflow tab: attempt-scoped cards over the
 * full population, daily attempt-count series, and a grouped table (one row
 * per repo/workflow/ref/resource_model) bounded at the newest 500 groups.
 * Groups arrive pre-aggregated from SQL (fetchWorkflowGroupRows, ADR-021).
 */
export function buildWorkflowDashboardResult(
  attempts: WorkflowAttemptRow[],
  groups: WorkflowGroupRow[],
  cards: WorkflowCardSet,
  oneRepo: boolean,
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
): WorkflowDashboardResult {
  // Daily attempt count: per repo (all) or per workflow file (one repo).
  const dailyByKey = new Map<string, Map<string, number>>();
  for (const a of attempts) {
    const key = oneRepo ? (a.workflowFile ?? '(unknown)') : a.repoKey;
    if (!dailyByKey.has(key)) dailyByKey.set(key, new Map());
    const dm = dailyByKey.get(key)!;
    dm.set(a.runDate, (dm.get(a.runDate) ?? 0) + 1);
  }
  const series: WorkflowSeriesPoint[] = [];
  for (const [key, dm] of dailyByKey) {
    for (const [date, attempts] of dm) {
      series.push({ date, key, attempts });
    }
  }
  series.sort((a, b) => b.date.localeCompare(a.date));
  const boundedSeries = series.slice(0, query.observationLimit);
  boundedSeries.sort((a, b) =>
    a.date === b.date
      ? a.key.localeCompare(b.key)
      : a.date.localeCompare(b.date),
  );

  // Groups arrive pre-aggregated from SQL (fetchWorkflowGroupRows, ADR-021):
  // one row per (repo, workflow_file, workflow_ref, resource_model).
  const allRows: WorkflowTableRow[] = groups.map((g) => ({
    repoKey: g.repoKey,
    workflowFile: g.workflowFile,
    workflowRef: g.workflowRef,
    resourceModel: g.resourceModel,
    avgWorkflowTotalDuration:
      g.avgWorkflowTotalDuration == null
        ? undefined
        : g.avgWorkflowTotalDuration,
    attemptCount: g.attemptCount,
    successCount: g.successCount,
    failureRate:
      g.terminalCount > 0
        ? ((g.terminalCount - g.successCount) / g.terminalCount) * 100
        : 0,
    machineHours: g.machineHours,
    unknownCostCount: g.unknownCostCount,
    latestDate: g.latestDate,
  }));
  allRows.sort(
    (a, b) =>
      b.latestDate.localeCompare(a.latestDate) ||
      b.machineHours - a.machineHours,
  );

  const observations = allRows.slice(0, query.observationLimit);
  const truncated = allRows.length > query.observationLimit;
  const totalRows = observations.length;
  const pageStart = (query.page - 1) * query.pageSize;
  const pagedRows = observations.slice(pageStart, pageStart + query.pageSize);

  const unknownResourceSamples = groups.reduce(
    (sum, g) => sum + g.unknownCostCount,
    0,
  );

  return {
    tab: 'workflow',
    cards,
    series: boundedSeries,
    rows: pagedRows,
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    displayedObservationCount: observations.length,
    truncated,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

/**
 * Lazy drill-down: tracked workflow_attempts for one (repo, workflow_file,
 * workflow_ref, resource_model) group, bounded to the newest N. Returns
 * queue/runtime/conclusion for the stacked chart (spec §5.3). Scoped to
 * resource_model (when known) so the drill-down matches the row's
 * Machine-Hours basis. No date window — bounded by LIMIT (spec §6).
 */
export async function fetchWorkflowAttemptDrilldown(
  repoId: number,
  repoKey: string,
  workflowFile: string,
  workflowRef: string | null,
  resourceModel: string | null,
  limit = 100,
): Promise<Array<{
  runId: number;
  runAttempt: number;
  repoKey: string;
  queueDurationSeconds: number | null;
  runtimeSeconds: number | null;
  totalDurationSeconds: number | null;
  conclusion: string | null;
  status: string;
  runDate: string;
}>> {
  const client = await getDatabaseClient();
  try {
    const params: Array<string | number> = [repoId, workflowFile, limit];
    let clauses = '';
    if (workflowRef) {
      params.push(workflowRef);
      clauses += ` AND wa.workflow_ref = $${params.length}`;
    }
    if (resourceModel && resourceModel !== 'unknown') {
      params.push(resourceModel);
      clauses += ` AND EXISTS (
        SELECT 1 FROM workflow_jobs wj
        WHERE wj.run_id = wa.run_id AND wj.run_attempt = wa.run_attempt
          AND wj.resource_model = $${params.length}
      )`;
    }
    const { rows } = await client.query(
      `SELECT r.id AS run_id, r.date, wa.run_attempt, wa.status, wa.conclusion,
              wa.queue_duration_seconds, wa.runtime_seconds,
              wa.total_duration_seconds
       FROM workflow_attempts wa
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id = $1
         AND wa.tracked = 1
         AND wa.workflow_file = $2${clauses}
       ORDER BY r.date DESC, r.id DESC, wa.run_attempt DESC
       LIMIT $3`,
      params,
    );
    return rows.map((row) => ({
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      repoKey,
      queueDurationSeconds:
        row.queue_duration_seconds == null
          ? null
          : Number(row.queue_duration_seconds),
      runtimeSeconds:
        row.runtime_seconds == null ? null : Number(row.runtime_seconds),
      totalDurationSeconds:
        row.total_duration_seconds == null
          ? null
          : Number(row.total_duration_seconds),
      conclusion: (row.conclusion as string | null) ?? null,
      status: String(row.status),
      runDate: String(row.date),
    }));
  } finally {
    client.release();
  }
}

// ---- Job + Queue tab read models (spec §5.4, §5.5) ---------------------

export function buildJobCards(
  stats: JobPopulationStats,
  groups: JobGroupRow[],
  oneRepo: boolean,
): JobCardSet {
  // Percentiles over successful Job Total Duration arrive from SQL
  // percentile_disc (nearest-rank convention, spec §4).
  const jobTotals = new Map<string, number>();
  if (oneRepo) {
    for (const group of groups) {
      if (group.jobName) {
        jobTotals.set(
          group.jobName,
          (jobTotals.get(group.jobName) ?? 0) + group.machineHours,
        );
      }
    }
  }
  const topJob = [...jobTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([jobName, machineHours]) => ({ jobName, machineHours }))[0];

  return {
    totalJobs: stats.totalJobs,
    p50TotalDuration:
      stats.p50TotalDuration == null ? undefined : stats.p50TotalDuration,
    p90TotalDuration:
      stats.p90TotalDuration == null ? undefined : stats.p90TotalDuration,
    successRate:
      stats.terminalCount > 0
        ? (stats.successCount / stats.terminalCount) * 100
        : 0,
    contributingRepoCount: new Set(groups.map((g) => g.repoKey)).size,
    topJob,
  };
}

export function buildJobDashboardResult(
  stats: JobPopulationStats,
  groups: JobGroupRow[],
  dailyCounts: DailyCountPoint[],
  cards: JobCardSet,
  oneRepo: boolean,
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
): JobDashboardResult {
  // Daily job count: per repo (all) or per job name (one repo); the key is
  // resolved by the fetcher (fetchJobDailyCounts / fetchJobNameDailyCounts).
  const series: JobSeriesPoint[] = dailyCounts.map((p) => ({
    date: p.date,
    key: p.key,
    jobs: p.count,
  }));
  series.sort((a, b) => b.date.localeCompare(a.date));
  const boundedSeries = series.slice(0, query.observationLimit);
  boundedSeries.sort((a, b) =>
    a.date === b.date
      ? a.key.localeCompare(b.key)
      : a.date.localeCompare(b.date),
  );

  // Groups arrive pre-aggregated from SQL (fetchJobGroupRows, ADR-021):
  // one row per (repo, workflow_file, workflow_ref, job_name, model).
  const allRows: JobTableRow[] = groups.map((g) => ({
    repoKey: g.repoKey,
    workflowFile: g.workflowFile,
    workflowRef: g.workflowRef,
    jobName: g.jobName,
    resourceModel: g.resourceModel,
    avgJobTotalDuration:
      g.avgJobTotalDuration == null ? undefined : g.avgJobTotalDuration,
    executionCount: g.executionCount,
    successCount: g.successCount,
    failureRate:
      g.terminalCount > 0
        ? ((g.terminalCount - g.successCount) / g.terminalCount) * 100
        : 0,
    machineHours: g.machineHours,
    unknownCostCount: g.unknownCostCount,
    latestDate: g.latestDate,
  }));
  allRows.sort(
    (a, b) =>
      b.latestDate.localeCompare(a.latestDate) ||
      b.machineHours - a.machineHours,
  );

  const observations = allRows.slice(0, query.observationLimit);
  const truncated = allRows.length > query.observationLimit;
  const totalRows = observations.length;
  const pageStart = (query.page - 1) * query.pageSize;
  const pagedRows = observations.slice(pageStart, pageStart + query.pageSize);
  const unknownResourceSamples = stats.unknownResourceSamples;

  return {
    tab: 'job',
    cards,
    series: boundedSeries,
    rows: pagedRows,
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    displayedObservationCount: observations.length,
    truncated,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

/**
 * Lazy drill-down: job attempt instances (run_id + run_attempt + job_id)
 * for one (repo, workflow_file, workflow_ref, job_name, resource_model)
 * group, bounded to newest N. Returns queue/runtime/conclusion for the
 * stacked chart (spec §5.4).
 */
export async function fetchJobAttemptDrilldown(
  repoId: number,
  repoKey: string,
  workflowFile: string,
  workflowRef: string | null,
  jobName: string,
  resourceModel: string | null,
  limit = 100,
): Promise<Array<{
  runId: number;
  runAttempt: number;
  jobId: number;
  repoKey: string;
  queueDurationSeconds: number | null;
  runtimeSeconds: number | null;
  totalDurationSeconds: number | null;
  resourceModel: string | null;
  conclusion: string | null;
  runDate: string;
}>> {
  const client = await getDatabaseClient();
  try {
    const params: Array<string | number> = [
      repoId,
      workflowFile,
      jobName,
      limit,
    ];
    let clauses = '';
    if (workflowRef) {
      params.push(workflowRef);
      clauses += ` AND wa.workflow_ref = $${params.length}`;
    }
    if (resourceModel && resourceModel !== 'unknown') {
      params.push(resourceModel);
      clauses += ` AND wj.resource_model = $${params.length}`;
    }
    const { rows } = await client.query(
      `SELECT r.id AS run_id, r.date, wa.run_attempt, wj.job_id, wj.queue_duration_seconds,
              wj.runtime_seconds, wj.total_duration_seconds, wj.resource_model,
              wj.conclusion
       FROM workflow_jobs wj
       JOIN workflow_attempts wa
         ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id = $1
         AND wa.tracked = 1
         AND wa.workflow_file = $2
         AND wj.name = $3${clauses}
       ORDER BY r.date DESC, r.id DESC, wa.run_attempt DESC, wj.job_id DESC
       LIMIT $4`,
      params,
    );
    return rows.map((row) => ({
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      jobId: Number(row.job_id),
      repoKey,
      queueDurationSeconds:
        row.queue_duration_seconds == null
          ? null
          : Number(row.queue_duration_seconds),
      runtimeSeconds:
        row.runtime_seconds == null ? null : Number(row.runtime_seconds),
      totalDurationSeconds:
        row.total_duration_seconds == null
          ? null
          : Number(row.total_duration_seconds),
      resourceModel: (row.resource_model as string | null) ?? null,
      conclusion: (row.conclusion as string | null) ?? null,
      runDate: String(row.date),
    }));
  } finally {
    client.release();
  }
}

export function buildQueueCards(stats: QueuePopulationStats): QueueCardSet {
  return {
    p50QueueDuration:
      stats.p50QueueDuration == null ? undefined : stats.p50QueueDuration,
    p90QueueDuration:
      stats.p90QueueDuration == null ? undefined : stats.p90QueueDuration,
    maxQueueDuration:
      stats.maxQueueDuration == null ? undefined : stats.maxQueueDuration,
    shareOverOneHour:
      stats.sampleCount > 0
        ? (stats.overOneHourCount / stats.sampleCount) * 100
        : 0,
    distinctResourceModelCount: stats.distinctResourceModelCount,
  };
}

export function buildQueueDashboardResult(
  stats: QueuePopulationStats,
  groups: QueueGroupRow[],
  dailyP90: QueueDailyPoint[],
  cards: QueueCardSet,
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'> & {
    resourceModel?: string;
  },
): QueueDashboardResult {
  // Daily P90 queue per resource model (spec §5.5); P90s arrive from SQL
  // percentile_disc (nearest-rank) and the optional model filter is applied
  // by the fetcher.
  const series: QueueSeriesPoint[] = dailyP90.map((p) => ({
    date: p.date,
    resourceModel: p.resourceModel,
    p90: p.p90,
  }));
  series.sort((a, b) => b.date.localeCompare(a.date));
  const boundedSeries = series.slice(0, query.observationLimit);
  boundedSeries.sort((a, b) =>
    a.date === b.date
      ? a.resourceModel.localeCompare(b.resourceModel)
      : a.date.localeCompare(b.date),
  );

  // Groups arrive pre-aggregated from SQL (fetchQueueGroupRows, ADR-021):
  // one row per (repo, workflow_file, workflow_ref, job_name, model).
  const allRows: QueueTableRow[] = groups.map((g) => ({
    repoKey: g.repoKey,
    workflowFile: g.workflowFile,
    workflowRef: g.workflowRef,
    jobName: g.jobName,
    resourceModel: g.resourceModel,
    queueP90: g.queueP90 == null ? undefined : g.queueP90,
    executionCount: g.executionCount,
    successRate:
      g.terminalCount > 0 ? (g.successCount / g.terminalCount) * 100 : 0,
    latestDate: g.latestDate,
  }));
  // ponytail: newest-first by run date (spec §3 date anchor), then
  // worst-queue-first as a stable tiebreaker — matches Job/Workflow/Cost.
  allRows.sort(
    (a, b) =>
      b.latestDate.localeCompare(a.latestDate) ||
      (b.queueP90 ?? -1) - (a.queueP90 ?? -1),
  );

  const observations = allRows.slice(0, query.observationLimit);
  const truncated = allRows.length > query.observationLimit;
  const totalRows = observations.length;
  const pageStart = (query.page - 1) * query.pageSize;
  const pagedRows = observations.slice(pageStart, pageStart + query.pageSize);

  const invalidTimingSamples = stats.invalidTimingSamples;
  // ponytail: Queue's per-model series skips jobs without a resourceModel;
  // count those as unknown-resource samples (spec §3 partial state) instead
  // of duplicating the invalid-timing count into two distinct quality fields.
  const unknownResourceSamples = stats.unknownResourceSamples;

  return {
    tab: 'queue',
    cards,
    series: boundedSeries,
    rows: pagedRows,
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    displayedObservationCount: observations.length,
    truncated,
    quality: {
      invalidTimingSamples,
      unknownResourceSamples,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

/**
 * Server seam entry point. Fetches the filtered population, computes the
 * full-population cards and the bounded observation result. Cached per
 * identical query via React `cache` (spec §6: no GitHub API on reads).
 */
export const getDashboardReadModel = cache(
  async (input: DashboardQuery): Promise<DashboardReadResult> => {
    validateDashboardQuery(input);

    const options = await getTrackedRepoOptions();
    const repoRows = await resolveRepoRows(options, input.repoKey);

    if (input.tab === 'cost') {
      const [groups, dailySeries, mergedPrCount] = await Promise.all([
        fetchWorkflowGroupRows(repoRows, input.startDate, input.endDate),
        fetchCostDailyMachineHours(repoRows, input.startDate, input.endDate),
        fetchCostMergedPrCount(repoRows, input.startDate, input.endDate),
      ]);
      const cards = buildCostCards(
        groups,
        mergedPrCount,
        dayCount(input.startDate, input.endDate),
        repoRows.length === 1,
      );
      return buildCostDashboardResult(groups, dailySeries, cards, {
        page: input.page,
        pageSize: input.pageSize,
        observationLimit: input.observationLimit,
      });
    }

    if (input.tab === 'workflow') {
      const [attempts, groups] = await Promise.all([
        fetchWorkflowAttemptRows(repoRows, input.startDate, input.endDate),
        fetchWorkflowGroupRows(repoRows, input.startDate, input.endDate),
      ]);
      const cards = buildWorkflowCards(attempts, groups, repoRows.length === 1);
      return buildWorkflowDashboardResult(
        attempts,
        groups,
        cards,
        repoRows.length === 1,
        {
          page: input.page,
          pageSize: input.pageSize,
          observationLimit: input.observationLimit,
        },
      );
    }

    if (input.tab === 'job' || input.tab === 'queue') {
      const oneRepo = repoRows.length === 1;
      if (input.tab === 'job') {
        const [groups, stats, dailyCounts] = await Promise.all([
          fetchJobGroupRows(repoRows, input.startDate, input.endDate),
          fetchJobPopulationStats(repoRows, input.startDate, input.endDate),
          oneRepo
            ? fetchJobNameDailyCounts(repoRows[0].id, input.startDate, input.endDate)
            : fetchJobDailyCounts(repoRows, input.startDate, input.endDate),
        ]);
        const cards = buildJobCards(stats, groups, oneRepo);
        return buildJobDashboardResult(stats, groups, dailyCounts, cards, oneRepo, {
          page: input.page,
          pageSize: input.pageSize,
          observationLimit: input.observationLimit,
        });
      }
      const [groups, stats, dailyP90] = await Promise.all([
        fetchQueueGroupRows(repoRows, input.startDate, input.endDate),
        fetchQueuePopulationStats(repoRows, input.startDate, input.endDate),
        fetchQueueDailyP90(repoRows, input.startDate, input.endDate, input.resourceModel),
      ]);
      const cards = buildQueueCards(stats);
      return buildQueueDashboardResult(stats, groups, dailyP90, cards, {
        page: input.page,
        pageSize: input.pageSize,
        observationLimit: input.observationLimit,
        resourceModel: input.resourceModel,
      });
    }

    // PR tab (slice 1).
    const [rawRows, runSeries] = await Promise.all([
      fetchPrMetricRows(repoRows, input.startDate, input.endDate),
      fetchPrRunSeries(repoRows, input.startDate, input.endDate),
    ]);
    const enriched = buildEnrichedRows(rawRows, repoRows);
    const seriesTimestamps = runSeries
      .slice(0, input.observationLimit)
      .map((point) => point.date);
    const jobCounts = await fetchPrJobConcurrencyCounts(
      repoRows,
      input.startDate,
      input.endDate,
      seriesTimestamps,
    );
    return buildPrDashboardResult(enriched, runSeries, {
      page: input.page,
      pageSize: input.pageSize,
      observationLimit: input.observationLimit,
    }, jobCounts);
  },
);

const DEFAULT_DAY_WINDOW: Record<DashboardTab, number> = {
  pr: 7,
  cost: 14,
  workflow: 14,
  job: 14,
  queue: 14,
};

/**
 * Parse dashboard search params into a validated query. Date range defaults
 * to 7 days for the PR tab and 14 days otherwise (spec §3).
 */
export function parseDashboardQuery(params: URLSearchParams): DashboardQuery {
  const tabRaw = params.get('tab');
  const tab: DashboardTab =
    tabRaw && TABS.includes(tabRaw as DashboardTab)
      ? (tabRaw as DashboardTab)
      : 'pr';
  const repoKey = params.get('repo') || undefined;
  const resourceModel = params.get('resourceModel') || undefined;
  const days = intParam(params, 'days', DEFAULT_DAY_WINDOW[tab]);
  const startDate = params.get('startDate') || defaultDate(days);
  const endDate = params.get('endDate') || todayUtc();
  const page = intParam(params, 'page', 1);
  return {
    tab,
    startDate,
    endDate,
    repoKey,
    resourceModel,
    page,
    pageSize: DEFAULT_PR_PAGE_SIZE,
    observationLimit: DEFAULT_OBSERVATION_LIMIT,
  };
}

/** Parse dashboard search params into a validated query (PR tab slice 1). */
export function parsePrDashboardQuery(params: URLSearchParams): DashboardQuery {
  return parseDashboardQuery(params);
}

function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
