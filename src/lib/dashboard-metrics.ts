/**
 * Canonical dashboard metric helpers (ADR-008, implementation spec §4).
 *
 * Pure functions shared by the server read-model seam and the client
 * drill-down. Eligibility rules are enforced here so cards, series, and
 * tables never fabricate Machine-Hours or clamp invalid timing.
 */

export type MetricStats = {
  avg: number;
  p50: number;
  p90: number;
  sampleCount: number;
};

/** Repository's existing percentile convention (overview-metrics.ts). */
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * p) - 1);
  return sortedValues[index] ?? 0;
}

/** Average + P50 + P90 over a set of already-validated numeric samples. */
export function computeStats(validSamples: number[]): MetricStats {
  const sorted = [...validSamples].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { avg: 0, p50: 0, p90: 0, sampleCount: 0 };
  }
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    sampleCount: sorted.length,
  };
}

/**
 * Seconds between two timestamps. Returns `undefined` (Invalid Timing
 * Sample) when either side is missing or the result is negative — per the
 * spec, negative durations are excluded and counted, never clamped to zero.
 */
export function durationSeconds(start?: string | null, end?: string | null): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  const seconds = Math.round((endMs - startMs) / 1000);
  return seconds < 0 ? undefined : seconds;
}

/**
 * Machine-Hours = Job Runtime × Resource Count ÷ 3600 (CONTEXT.md).
 * Excludes queue time. Returns undefined (Unknown-Cost Sample) unless both
 * a positive Resource Count and a valid Job Runtime are present.
 */
export function machineHours(
  jobRuntimeSeconds?: number | null,
  resourceCount?: number | null,
): number | undefined {
  if (
    jobRuntimeSeconds === undefined ||
    jobRuntimeSeconds === null ||
    jobRuntimeSeconds < 0
  ) {
    return undefined;
  }
  if (!resourceCount || resourceCount <= 0) return undefined;
  return (jobRuntimeSeconds * resourceCount) / 3600;
}

export type PrTimingParts = {
  queue?: number; // created_at → ci_started_at
  ciRuntime?: number; // ci_started_at → ci_completed_at
  review?: number; // ci_completed_at → merged_at
  endToEnd?: number; // queue + ciRuntime + review (only when all three valid)
  forcedMerge: boolean;
  invalidTiming: boolean;
};

/**
 * Compute the four PR timing parts plus the Forced Merge Indicator from raw
 * pr_metrics timestamps. Negative samples are dropped (invalid), matching
 * the spec: "negative values are not clamped into normal review metrics".
 */
export function computePrTimingParts(pr: {
  created_at?: string | null;
  ci_started_at?: string | null;
  ci_completed_at?: string | null;
  merged_at?: string | null;
}): PrTimingParts {
  const queue = durationSeconds(pr.created_at, pr.ci_started_at);
  const ciRuntime = durationSeconds(pr.ci_started_at, pr.ci_completed_at);
  const review = durationSeconds(pr.ci_completed_at, pr.merged_at);

  // Forced Merge Indicator: PR merged before tracked CI completed. Requires
  // both timestamps; partial CI history is excluded from the eligible set.
  const forcedMerge = Boolean(
    pr.merged_at &&
      pr.ci_completed_at &&
      Date.parse(pr.merged_at) < Date.parse(pr.ci_completed_at),
  );

  const invalidTiming = Boolean(
    (pr.ci_started_at || pr.ci_completed_at) &&
      (queue === undefined || ciRuntime === undefined),
  );

  const endToEnd =
    queue !== undefined && ciRuntime !== undefined && review !== undefined
      ? queue + ciRuntime + review
      : undefined;

  return { queue, ciRuntime, review, endToEnd, forcedMerge, invalidTiming };
}

/** Summarize Machine-Hours by Resource Model for a set of jobs. */
export function summarizeMachineHoursByResourceModel(
  jobs: Array<{
    resourceModel?: string | null;
    resourceCount?: number | null;
    runtimeSeconds?: number | null;
  }>,
): Array<{ resourceModel: string; machineHours: number; jobCount: number; unknownCostCount: number }> {
  const groups = new Map<
    string,
    { machineHours: number; jobCount: number; unknownCostCount: number }
  >();

  for (const job of jobs) {
    const model = job.resourceModel || 'unknown';
    const entry = groups.get(model) ?? {
      machineHours: 0,
      jobCount: 0,
      unknownCostCount: 0,
    };
    const mh = machineHours(job.runtimeSeconds, job.resourceCount);
    if (mh !== undefined) {
      entry.machineHours += mh;
    } else {
      entry.unknownCostCount += 1;
    }
    entry.jobCount += 1;
    groups.set(model, entry);
  }

  return [...groups.entries()]
    .map(([resourceModel, entry]) => ({ resourceModel, ...entry }))
    .sort((a, b) => b.machineHours - a.machineHours);
}
