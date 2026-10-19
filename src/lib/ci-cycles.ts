/**
 * PR-level CI cycle and card-hours metrics (ADR-020).
 *
 * Pure functions shared by the client PR drill-down. A "CI cycle" is one
 * push batch: all workflow runs triggered by the same push share the same
 * head_sha AND the same run created_at (GitHub stamps every run of one
 * push event with the identical timestamp), so cycles are grouped by that
 * pair — never by loose time proximity. Cycle wall time is the
 * user-perceived wait: earliest run created_at → latest run completed_at,
 * queue time included.
 *
 * Card-hours follow ADR-018 semantics: Job Runtime × Resource Count ÷
 * 3600 for jobs with valid timing and a positive known count. Cancelled
 * jobs' measured consumption is included in totals (a cancelled job may
 * still have occupied cards) and broken out so hangs stay auditable;
 * unknown-cost and unattributed jobs are counted, never zero-filled.
 */

import type { Run } from './types';
import { machineHours } from './dashboard-metrics';
import { percentile } from './dashboard-metrics';

export type CycleRunSummary = {
  runId: number;
  runAttempt: number;
  workflowFile: string | null;
  conclusion: string;
  branchMatched: boolean;
  /** Run created_at (attempt-scoped). */
  startedAt: string;
  /** Latest of completed_at / updated_at; undefined while in flight. */
  endedAt: string | undefined;
  /** Run wall seconds (queue included); undefined while open. */
  wallSeconds: number | undefined;
  headSha: string | undefined;
  htmlUrl: string | undefined;
  /** Failed job names in this run (unique, capped). "Why" needs logs — names only. */
  failedJobNames: string[];
  failedJobCount: number;
  cancelledJobCount: number;
};

export type CiCycle = {
  /** Earliest run created_at within the push batch. */
  startedAt: string;
  /**
   * Latest run completed_at (falls back to updated_at for in-flight runs).
   * Undefined when no run in the batch has a usable end timestamp.
   */
  endedAt: string | undefined;
  /** User-perceived wall seconds (queue included); undefined while any run lacks an end. */
  wallSeconds: number | undefined;
  runs: CycleRunSummary[];
};

/** Bucket key for one push batch: identical head_sha + identical created_at. */
function cycleKey(run: Run): string {
  return `${run.head_sha ?? ''}#${run.created_at}`;
}

function runEndTimestamp(run: Run): string | undefined {
  const end = run.updated_at || run.created_at;
  const ms = Date.parse(end);
  return Number.isNaN(ms) ? undefined : end;
}

const FAILED_JOB_NAME_CAP = 5;

function summarizeRunJobs(run: Run): {
  failedJobNames: string[];
  failedJobCount: number;
  cancelledJobCount: number;
} {
  const names = new Set<string>();
  let failedJobCount = 0;
  let cancelledJobCount = 0;
  for (const job of run.jobs ?? []) {
    if (job.conclusion === 'failure') {
      failedJobCount += 1;
      if (names.size < FAILED_JOB_NAME_CAP) names.add(job.name);
    } else if (job.conclusion === 'cancelled') {
      cancelledJobCount += 1;
    }
  }
  return {
    failedJobNames: [...names],
    failedJobCount,
    cancelledJobCount,
  };
}

/** Group attempt-scoped runs into CI cycles (one cycle per push batch). */
export function groupRunsIntoCycles(runs: Run[]): CiCycle[] {
  const buckets = new Map<string, CiCycle>();

  for (const run of runs) {
    const key = cycleKey(run);
    const startMs = Date.parse(run.created_at);
    if (Number.isNaN(startMs)) continue;

    let cycle = buckets.get(key);
    if (!cycle) {
      cycle = {
        startedAt: run.created_at,
        endedAt: undefined,
        wallSeconds: undefined,
        runs: [],
      };
      buckets.set(key, cycle);
    }

    cycle.runs.push({
      runId: run.id,
      runAttempt: run.runAttempt ?? 1,
      workflowFile: run.workflowFile ?? null,
      conclusion: run.conclusion || run.status || 'unknown',
      branchMatched: Boolean(run.branchMatched),
      startedAt: run.created_at,
      endedAt: runEndTimestamp(run),
      wallSeconds: undefined,
      headSha: run.head_sha,
      htmlUrl: run.html_url,
      ...summarizeRunJobs(run),
    });

    const end = runEndTimestamp(run);
    if (end) {
      const endMs = Date.parse(end);
      if (
        cycle.endedAt === undefined ||
        endMs > Date.parse(cycle.endedAt)
      ) {
        cycle.endedAt = end;
      }
    }
  }

  const cycles = [...buckets.values()];
  for (const cycle of cycles) {
    if (cycle.endedAt !== undefined) {
      const seconds = Math.round(
        (Date.parse(cycle.endedAt) - Date.parse(cycle.startedAt)) / 1000,
      );
      cycle.wallSeconds = seconds < 0 ? undefined : seconds;
    }
    for (const run of cycle.runs) {
      if (run.endedAt !== undefined) {
        const seconds = Math.round(
          (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000,
        );
        run.wallSeconds = seconds < 0 ? undefined : seconds;
      }
    }
  }

  return cycles.sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

export type CycleWallStats = {
  cycleCount: number;
  /** Cycles still missing an end timestamp (in flight or partial data). */
  openCycleCount: number;
  medianWallSeconds: number;
  p90WallSeconds: number;
  maxWallSeconds: number;
  /** Sum over closed cycles — NOT the PR envelope; cycles do not overlap-count idle time between pushes. */
  totalWallSeconds: number;
};

/** Wall-time stats over closed cycles (nearest-rank percentiles, ADR-008). */
export function summarizeCycleWalls(cycles: CiCycle[]): CycleWallStats {
  const closed = cycles
    .map((cycle) => cycle.wallSeconds)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  return {
    cycleCount: cycles.length,
    openCycleCount: cycles.length - closed.length,
    medianWallSeconds: percentile(closed, 0.5),
    p90WallSeconds: percentile(closed, 0.9),
    maxWallSeconds: closed.length > 0 ? closed[closed.length - 1] : 0,
    totalWallSeconds: closed.reduce((acc, value) => acc + value, 0),
  };
}

export type CardHoursGroup = 'success' | 'failure' | 'cancelled' | 'other';

export type CardHoursSummary = {
  /** Known-attribution card-hours per conclusion group (cancelled included). */
  byConclusion: Record<CardHoursGroup, number>;
  /** Known-attribution total across all conclusion groups. */
  totalCardHours: number;
  perModel: Array<{
    resourceModel: string;
    cardHours: number;
    jobCount: number;
  }>;
  /** Jobs with a resource model but missing count/valid runtime (unknown cost, ADR-018). */
  unknownCostCount: number;
  /** Jobs without any resource attribution (e.g., GPU labels not mapped). */
  unattributedJobCount: number;
};

function conclusionGroup(conclusion: string): CardHoursGroup {
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure') return 'failure';
  if (conclusion === 'cancelled') return 'cancelled';
  return 'other';
}

/**
 * Card-hours for a PR's jobs, split by conclusion. Cancelled consumption
 * is kept in totals and broken out: a cancelled job may still have
 * occupied cards (including runner-lost hangs, which stay auditable).
 */
export function computeCardHoursSummary(
  jobs: Array<{
    resourceModel?: string | null;
    resourceCount?: number | null;
    runtimeSeconds?: number | null;
    conclusion?: string | null;
  }>,
): CardHoursSummary {
  const byConclusion: Record<CardHoursGroup, number> = {
    success: 0,
    failure: 0,
    cancelled: 0,
    other: 0,
  };
  const models = new Map<string, { cardHours: number; jobCount: number }>();
  let totalCardHours = 0;
  let unknownCostCount = 0;
  let unattributedJobCount = 0;

  for (const job of jobs) {
    if (!job.resourceModel) {
      unattributedJobCount += 1;
      continue;
    }
    const mh = machineHours(job.runtimeSeconds, job.resourceCount);
    if (mh === undefined) {
      unknownCostCount += 1;
      continue;
    }
    byConclusion[conclusionGroup(job.conclusion ?? '')] += mh;
    totalCardHours += mh;
    const entry = models.get(job.resourceModel) ?? {
      cardHours: 0,
      jobCount: 0,
    };
    entry.cardHours += mh;
    entry.jobCount += 1;
    models.set(job.resourceModel, entry);
  }

  return {
    byConclusion,
    totalCardHours,
    perModel: [...models.entries()]
      .map(([resourceModel, entry]) => ({ resourceModel, ...entry }))
      .sort((a, b) => b.cardHours - a.cardHours),
    unknownCostCount,
    unattributedJobCount,
  };
}

/**
 * Busy seconds = union of closed cycle intervals (ADR-020). Overlapping
 * cycles are counted once; this is NOT the naive sum of cycle walls and is
 * the honest counterpart to the PR-span idle time.
 */
export function computeCycleBusySeconds(cycles: CiCycle[]): number {
  const intervals = cycles
    .filter((cycle) => cycle.endedAt !== undefined)
    .map((cycle) => ({
      start: Date.parse(cycle.startedAt),
      end: Date.parse(cycle.endedAt as string),
    }))
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end >= iv.start)
    .sort((a, b) => a.start - b.start);

  let busy = 0;
  let cursorStart = Number.NaN;
  let cursorEnd = Number.NaN;
  for (const iv of intervals) {
    if (Number.isNaN(cursorEnd) || iv.start > cursorEnd) {
      if (!Number.isNaN(cursorEnd)) busy += cursorEnd - cursorStart;
      cursorStart = iv.start;
      cursorEnd = iv.end;
    } else if (iv.end > cursorEnd) {
      cursorEnd = iv.end;
    }
  }
  if (!Number.isNaN(cursorEnd)) busy += cursorEnd - cursorStart;

  return Math.round(busy / 1000);
}

/**
 * Merge linked PR attempts with branch-matched attempts. Linked rows win;
 * branch-matched rows are deduped and tagged so the UI can disclose the
 * attribution source. Bounded by the PR lifecycle upstream (repo scoped,
 * pull-request events only), so this merge stays a pure set operation.
 */
export function mergeAttemptRows(
  linked: Array<{ run_id: number; run_attempt: number }>,
  branchMatched: Array<{ run_id: number; run_attempt: number }>,
): Array<{ run_id: number; run_attempt: number; branchMatched: boolean }> {
  const seen = new Set(
    linked.map((row) => `${row.run_id}:${row.run_attempt}`),
  );
  const merged: Array<{
    run_id: number;
    run_attempt: number;
    branchMatched: boolean;
  }> = linked.map((row) => ({ ...row, branchMatched: false }));

  for (const row of branchMatched) {
    const key = `${row.run_id}:${row.run_attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...row, branchMatched: true });
  }

  return merged;
}
