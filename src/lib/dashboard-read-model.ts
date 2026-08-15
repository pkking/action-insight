import 'server-only';
import { cache } from 'react';

import { getTrackedRepoOptions, type RepoOption } from './server-homepage-data';
import { getDatabaseClient, query } from './db';
import { pgPlaceholders } from './pg-utils';
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

export type PrDashboardResult = DashboardResult<PrCardSet, PrSeriesPoint, PrTableRow>;

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

/**
 * Server seam entry point. Fetches the filtered population, computes the
 * full-population cards and the bounded observation result. Cached per
 * identical query via React `cache` (spec §6: no GitHub API on reads).
 */
export const getDashboardReadModel = cache(
  async (input: DashboardQuery): Promise<PrDashboardResult> => {
    validateDashboardQuery(input);
    if (input.tab !== 'pr') {
      throw new Error(`Tab "${input.tab}" is not implemented in slice 1`);
    }

    const options = await getTrackedRepoOptions();
    const repoRows = await resolveRepoRows(options, input.repoKey);
    const rawRows = await fetchPrMetricRows(repoRows, input.startDate, input.endDate);
    const enriched = buildEnrichedRows(rawRows, repoRows);
    return buildPrDashboardResult(enriched, {
      page: input.page,
      pageSize: input.pageSize,
      observationLimit: input.observationLimit,
    });
  },
);

/** Parse dashboard search params into a validated query (PR tab slice 1). */
export function parsePrDashboardQuery(params: URLSearchParams): DashboardQuery {
  const repoKey = params.get('repo') || undefined;
  const startDate = params.get('startDate') || defaultDate(1);
  const endDate = params.get('endDate') || todayUtc();
  const page = intParam(params, 'page', 1);
  return {
    tab: 'pr',
    startDate,
    endDate,
    repoKey,
    page,
    pageSize: DEFAULT_PR_PAGE_SIZE,
    observationLimit: DEFAULT_OBSERVATION_LIMIT,
  };
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
