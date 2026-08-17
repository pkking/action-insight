import 'server-only';
import { cache } from 'react';

import { getTrackedRepoOptions, type RepoOption } from './server-homepage-data';
import { getDatabaseClient, query } from './db';
import { pgPlaceholders } from './pg-utils';
import {
  computePrTimingParts,
  computeStats,
  machineHours,
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
  | WorkflowDashboardResult;

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
  date: string; // merged_at (yyyy-mm-dd) for the daily count line
  prNumber: number;
  repoKey: string;
  queue?: number;
  ciRuntime?: number;
  review?: number;
};

export type PrTableRow = {
  repoKey: string;
  prNumber: number;
  title: string;
  htmlUrl: string;
  queue?: number;
  ciRuntime?: number;
  review?: number;
  mergedAt: string;
  mergeState: string;
  forcedMerge: boolean;
  partialCiHistory: boolean;
};

export type PrDashboardResult = DashboardResult<PrCardSet, PrSeriesPoint, PrTableRow> & {
  tab: 'pr';
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
    const placeholders = pgPlaceholders(options.length * 2);
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
    const { queue, ciRuntime, review, endToEnd, forcedMerge } = row.timing;
    if (queue !== undefined && ciRuntime !== undefined && review !== undefined) {
      e2eSamples.push(endToEnd!);
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
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
): PrDashboardResult {
  const cards = buildPrCards(enriched);

  const sorted = [...enriched].sort((a, b) =>
    (b.merged_at ?? '').localeCompare(a.merged_at ?? ''),
  );
  const observations = sorted.slice(0, query.observationLimit);
  const truncated = sorted.length > query.observationLimit;

  const series: PrSeriesPoint[] = observations.map((row) => ({
    date: (row.merged_at ?? '').slice(0, 10),
    prNumber: row.pr_number,
    repoKey: row.repoKey,
    queue: row.timing.queue,
    ciRuntime: row.timing.ciRuntime,
    review: row.timing.review,
  }));

  const rows: PrTableRow[] = observations.map((row) => ({
    repoKey: row.repoKey,
    prNumber: row.pr_number,
    title: row.title,
    htmlUrl: row.html_url,
    queue: row.timing.queue,
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

export type CostJobRow = {
  repoKey: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  runDate: string; // runs.date (yyyy-mm-dd) — the Cost tab date anchor
  workflowFile: string | null;
  workflowRef: string | null;
  resourceModel: string | null;
  resourceCount: number | null;
  runtimeSeconds: number | null; // Job Runtime
  attemptConclusion: string | null;
  attemptTotalDurationSeconds: number | null; // Workflow Total Duration
};

/**
 * Fetch tracked workflow_jobs joined to workflow_attempts + runs for the
 * filtered repo/date window. Machine-Hours are computed downstream from
 * Job Runtime × Resource Count (ADR-008, spec §6). Tracked attempts only.
 */
export async function fetchCostJobRows(
  repoRows: RepoRow[],
  startDate: string,
  endDate: string,
): Promise<CostJobRow[]> {
  if (repoRows.length === 0) return [];
  const client = await getDatabaseClient();
  try {
    const placeholders = pgPlaceholders(repoRows.length);
    const { rows } = await client.query(
      `SELECT r.id AS run_id, r.repo_id, r.date, wa.run_attempt,
              wa.workflow_file, wa.workflow_ref, wa.conclusion AS attempt_conclusion,
              wa.total_duration_seconds AS attempt_total_duration_seconds,
              wj.job_id, wj.resource_model, wj.resource_count, wj.runtime_seconds
       FROM workflow_jobs wj
       JOIN workflow_attempts wa
         ON wa.run_id = wj.run_id AND wa.run_attempt = wj.run_attempt
       JOIN runs r ON r.id = wa.run_id
       WHERE r.repo_id IN (${placeholders})
         AND r.date >= $${repoRows.length + 1}
         AND r.date <= $${repoRows.length + 2}
         AND wa.tracked = 1
       ORDER BY r.date DESC, r.id DESC, wa.run_attempt DESC, wj.job_id`,
      [...repoRows.map((r) => r.id), startDate, endDate],
    );
    const idToKey = new Map(repoRows.map((r) => [r.id, r.key]));
    return rows.map((row) => ({
      repoKey: idToKey.get(Number(row.repo_id)) ?? 'unknown',
      runId: Number(row.run_id),
      runAttempt: Number(row.run_attempt),
      jobId: Number(row.job_id),
      runDate: String(row.date),
      workflowFile: (row.workflow_file as string | null) ?? null,
      workflowRef: (row.workflow_ref as string | null) ?? null,
      resourceModel: (row.resource_model as string | null) ?? null,
      resourceCount: row.resource_count == null ? null : Number(row.resource_count),
      runtimeSeconds:
        row.runtime_seconds == null ? null : Number(row.runtime_seconds),
      attemptConclusion: (row.attempt_conclusion as string | null) ?? null,
      attemptTotalDurationSeconds:
        row.attempt_total_duration_seconds == null
          ? null
          : Number(row.attempt_total_duration_seconds),
    }));
  } finally {
    client.release();
  }
}

/**
 * Count distinct merged PRs (pr_metrics.merged_at IS NOT NULL) that have at
 * least one attributable job (positive Resource Count + valid Job Runtime)
 * whose run falls in the same filtered window. Count-only join — no PR
 * timing is read (the single pr_metrics touch for the "per merged PR" card).
 */
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
  jobRows: CostJobRow[],
  mergedPrCount: number,
  daysInRange: number,
  oneRepo: boolean,
): CostCardSet {
  let totalMachineHours = 0;
  const repoTotals = new Map<string, number>();
  const wfTotals = new Map<string, number>();

  for (const row of jobRows) {
    const mh = machineHours(row.runtimeSeconds, row.resourceCount);
    if (mh !== undefined) {
      totalMachineHours += mh;
      repoTotals.set(row.repoKey, (repoTotals.get(row.repoKey) ?? 0) + mh);
      // Top workflow only meaningful for a single-repo selection.
      if (oneRepo && row.workflowFile) {
        wfTotals.set(
          row.workflowFile,
          (wfTotals.get(row.workflowFile) ?? 0) + mh,
        );
      }
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

export type CostGroupKey = string;

/** Group jobs by (repo, workflow_file, workflow_ref, resource_model). */
export function costGroupKey(row: CostJobRow): CostGroupKey {
  return [
    row.repoKey,
    row.workflowFile ?? '',
    row.workflowRef ?? '',
    row.resourceModel ?? 'unknown',
  ].join('\u0001');
}

type CostGroup = {
  key: CostGroupKey;
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  resourceModel: string;
  machineHours: number;
  unknownCostCount: number;
  attempts: Map<string, { totalDuration?: number; conclusion: string | null }>;
  // newest run date among the group's jobs — observation order anchor
  latestDate: string;
};

/**
 * Pure transformation from the full filtered job population to the bounded
 * Cost result: cards over the full population, daily series + grouped table
 * rows over the newest `observationLimit` job-observations (spec §3, §6).
 */
export function buildCostDashboardResult(
  jobRows: CostJobRow[],
  cards: CostCardSet,
  query: Pick<DashboardQuery, 'page' | 'pageSize' | 'observationLimit'>,
): CostDashboardResult {
  // Group the full population by (repo, workflow_file, workflow_ref, model).
  const groups = new Map<CostGroupKey, CostGroup>();
  for (const row of jobRows) {
    const key = costGroupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        repoKey: row.repoKey,
        workflowFile: row.workflowFile ?? '',
        workflowRef: row.workflowRef ?? '',
        resourceModel: row.resourceModel ?? 'unknown',
        machineHours: 0,
        unknownCostCount: 0,
        attempts: new Map(),
        latestDate: '',
      };
      groups.set(key, g);
    }
    const mh = machineHours(row.runtimeSeconds, row.resourceCount);
    if (mh !== undefined) g.machineHours += mh;
    else g.unknownCostCount += 1;
    const attemptKey = `${row.runId}:${row.runAttempt}`;
    const existing = g.attempts.get(attemptKey);
    if (!existing) {
      g.attempts.set(attemptKey, {
        totalDuration:
          row.attemptTotalDurationSeconds == null ||
          row.attemptTotalDurationSeconds < 0
            ? undefined
            : row.attemptTotalDurationSeconds,
        conclusion: row.attemptConclusion,
      });
    }
    if (row.runDate > g.latestDate) g.latestDate = row.runDate;
  }

  // Table rows: one per group. Sort newest-first by latest job date, then MH.
  const allRows: CostTableRow[] = [...groups.values()]
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

  // Daily series per repo over the full filtered population, capped at the
  // newest `observationLimit` (repo,date) points (spec §3). Daily points are
  // sparse (days × repos), so the cap rarely bites.
  const dailyByRepo = new Map<string, Map<string, number>>();
  for (const row of jobRows) {
    const mh = machineHours(row.runtimeSeconds, row.resourceCount);
    if (mh === undefined) continue;
    if (!dailyByRepo.has(row.repoKey)) dailyByRepo.set(row.repoKey, new Map());
    const dm = dailyByRepo.get(row.repoKey)!;
    dm.set(row.runDate, (dm.get(row.runDate) ?? 0) + mh);
  }
  const series: CostSeriesPoint[] = [];
  for (const [repoKey, dm] of dailyByRepo) {
    for (const [date, machineHours] of dm) {
      series.push({ date, repoKey, machineHours });
    }
  }
  // Newest-first to cap, then ascending for the left-to-right chart axis.
  series.sort((a, b) => b.date.localeCompare(a.date));
  const boundedSeries = series.slice(0, query.observationLimit);
  boundedSeries.sort((a, b) =>
    a.date === b.date
      ? a.repoKey.localeCompare(b.repoKey)
      : a.date.localeCompare(b.date),
  );

  const unknownResourceSamples = jobRows.filter(
    (r) =>
      machineHours(r.runtimeSeconds, r.resourceCount) === undefined,
  ).length;

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
  g: CostGroup,
  totalMachineHours: number,
): CostTableRow & { latestDate: string } {
  const attemptList = [...g.attempts.values()];
  const terminal = attemptList.filter((a) =>
    a.conclusion ? TERMINAL_CONCLUSIONS.has(a.conclusion) : false,
  );
  const successCount = terminal.filter(
    (a) => a.conclusion === 'success',
  ).length;
  const validDurations = attemptList
    .map((a) => a.totalDuration)
    .filter((v): v is number => v !== undefined);
  const avgWorkflowTotalDuration =
    validDurations.length > 0
      ? validDurations.reduce((s, v) => s + v, 0) / validDurations.length
      : undefined;
  const failureRate =
    terminal.length > 0
      ? ((terminal.length - successCount) / terminal.length) * 100
      : 0;
  return {
    repoKey: g.repoKey,
    workflowFile: g.workflowFile,
    workflowRef: g.workflowRef,
    resourceModel: g.resourceModel,
    avgWorkflowTotalDuration,
    attemptCount: attemptList.length,
    successCount,
    failureRate,
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

export function buildWorkflowCards(
  attempts: WorkflowAttemptRow[],
  jobRows: CostJobRow[],
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

  // Highest-Machine-Hour workflow (one repo only). Derived from job rows so
  // it reflects attributable cost, the same basis as the table.
  const wfTotals = new Map<string, number>();
  if (oneRepo) {
    for (const row of jobRows) {
      const mh = machineHours(row.runtimeSeconds, row.resourceCount);
      if (mh !== undefined && row.workflowFile) {
        wfTotals.set(row.workflowFile, (wfTotals.get(row.workflowFile) ?? 0) + mh);
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

export type WorkflowGroup = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  resourceModel: string;
  machineHours: number;
  unknownCostCount: number;
  attempts: Map<string, { totalDuration?: number; conclusion: string | null }>;
  latestDate: string;
};

/**
 * Pure transformation for the Workflow tab: attempt-scoped cards over the
 * full population, daily attempt-count series, and a grouped table (one row
 * per repo/workflow/ref/resource_model) bounded at the newest 500 groups.
 * Reuses the Cost grouping since the table contract is identical (spec §5.3).
 */
export function buildWorkflowDashboardResult(
  attempts: WorkflowAttemptRow[],
  jobRows: CostJobRow[],
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

  // Group jobs by (repo, workflow_file, workflow_ref, resource_model).
  const groups = new Map<string, WorkflowGroup>();
  for (const row of jobRows) {
    const key = [
      row.repoKey,
      row.workflowFile ?? '',
      row.workflowRef ?? '',
      row.resourceModel ?? 'unknown',
    ].join('\u0001');
    let g = groups.get(key);
    if (!g) {
      g = {
        repoKey: row.repoKey,
        workflowFile: row.workflowFile ?? '',
        workflowRef: row.workflowRef ?? '',
        resourceModel: row.resourceModel ?? 'unknown',
        machineHours: 0,
        unknownCostCount: 0,
        attempts: new Map(),
        latestDate: '',
      };
      groups.set(key, g);
    }
    const mh = machineHours(row.runtimeSeconds, row.resourceCount);
    if (mh !== undefined) g.machineHours += mh;
    else g.unknownCostCount += 1;
    const attemptKey = `${row.runId}:${row.runAttempt}`;
    if (!g.attempts.has(attemptKey)) {
      g.attempts.set(attemptKey, {
        totalDuration:
          row.attemptTotalDurationSeconds == null ||
          row.attemptTotalDurationSeconds < 0
            ? undefined
            : row.attemptTotalDurationSeconds,
        conclusion: row.attemptConclusion,
      });
    }
    if (row.runDate > g.latestDate) g.latestDate = row.runDate;
  }

  const allRows: WorkflowTableRow[] = [...groups.values()].map((g) => {
    const attemptList = [...g.attempts.values()];
    const terminal = attemptList.filter((a) =>
      a.conclusion ? TERMINAL_CONCLUSIONS.has(a.conclusion) : false,
    );
    const successCount = terminal.filter(
      (a) => a.conclusion === 'success',
    ).length;
    const validDurations = attemptList
      .map((a) => a.totalDuration)
      .filter((v): v is number => v !== undefined);
    return {
      repoKey: g.repoKey,
      workflowFile: g.workflowFile,
      workflowRef: g.workflowRef,
      resourceModel: g.resourceModel,
      avgWorkflowTotalDuration:
        validDurations.length > 0
          ? validDurations.reduce((s, v) => s + v, 0) / validDurations.length
          : undefined,
      attemptCount: attemptList.length,
      successCount,
      failureRate:
        terminal.length > 0
          ? ((terminal.length - successCount) / terminal.length) * 100
          : 0,
      machineHours: g.machineHours,
      unknownCostCount: g.unknownCostCount,
      latestDate: g.latestDate,
    };
  });
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

  const unknownResourceSamples = jobRows.filter(
    (r) => machineHours(r.runtimeSeconds, r.resourceCount) === undefined,
  ).length;

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
      const [jobRows, mergedPrCount] = await Promise.all([
        fetchCostJobRows(repoRows, input.startDate, input.endDate),
        fetchCostMergedPrCount(repoRows, input.startDate, input.endDate),
      ]);
      const cards = buildCostCards(
        jobRows,
        mergedPrCount,
        dayCount(input.startDate, input.endDate),
        repoRows.length === 1,
      );
      return buildCostDashboardResult(jobRows, cards, {
        page: input.page,
        pageSize: input.pageSize,
        observationLimit: input.observationLimit,
      });
    }

    if (input.tab === 'workflow') {
      const [attempts, jobRows] = await Promise.all([
        fetchWorkflowAttemptRows(repoRows, input.startDate, input.endDate),
        fetchCostJobRows(repoRows, input.startDate, input.endDate),
      ]);
      const cards = buildWorkflowCards(attempts, jobRows, repoRows.length === 1);
      return buildWorkflowDashboardResult(
        attempts,
        jobRows,
        cards,
        repoRows.length === 1,
        {
          page: input.page,
          pageSize: input.pageSize,
          observationLimit: input.observationLimit,
        },
      );
    }

    // PR tab (slice 1).
    const rawRows = await fetchPrMetricRows(repoRows, input.startDate, input.endDate);
    const enriched = buildEnrichedRows(rawRows, repoRows);
    return buildPrDashboardResult(enriched, {
      page: input.page,
      pageSize: input.pageSize,
      observationLimit: input.observationLimit,
    });
  },
);

const DEFAULT_DAY_WINDOW: Record<DashboardTab, number> = {
  pr: 1,
  cost: 14,
  workflow: 14,
  job: 14,
  queue: 14,
};

/**
 * Parse dashboard search params into a validated query. Date range defaults
 * to 1 day for the PR tab and 14 days otherwise (spec §3).
 */
export function parseDashboardQuery(params: URLSearchParams): DashboardQuery {
  const tabRaw = params.get('tab');
  const tab: DashboardTab =
    tabRaw && TABS.includes(tabRaw as DashboardTab)
      ? (tabRaw as DashboardTab)
      : 'pr';
  const repoKey = params.get('repo') || undefined;
  const startDate = params.get('startDate') || defaultDate(DEFAULT_DAY_WINDOW[tab]);
  const endDate = params.get('endDate') || todayUtc();
  const page = intParam(params, 'page', 1);
  return {
    tab,
    startDate,
    endDate,
    repoKey,
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
