import { describe, expect, it } from 'vitest';

import {
  computePrTimingParts,
  computeStats,
  durationSeconds,
  machineHours,
  percentile,
  summarizeMachineHoursByResourceModel,
} from './dashboard-metrics';

describe('percentile', () => {
  it('follows the repository ceiling-index convention', () => {
    // 1..10 → p50 index = ceil(0.5*10)-1 = 4 → 5; p90 = ceil(0.9*10)-1 = 8 → 9
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.9)).toBe(9);
  });

  it('returns 0 for empty input', () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('computeStats', () => {
  it('computes avg/p50/p90 and sampleCount over valid samples', () => {
    const stats = computeStats([10, 20, 30, 40, 50]);
    expect(stats.sampleCount).toBe(5);
    expect(stats.avg).toBe(30);
    expect(stats.p50).toBe(30);
    expect(stats.p90).toBe(50); // ceil(0.9*5)-1 = 3 → 40? index 3 of sorted = 40
  });

  it('returns zeros for no samples', () => {
    const stats = computeStats([]);
    expect(stats.sampleCount).toBe(0);
    expect(stats.avg).toBe(0);
  });
});

describe('durationSeconds', () => {
  it('returns undefined when either timestamp is missing', () => {
    expect(durationSeconds(null, '2026-01-01T00:00:00Z')).toBeUndefined();
    expect(durationSeconds('2026-01-01T00:00:00Z', undefined)).toBeUndefined();
  });

  it('returns undefined for negative durations (never clamped)', () => {
    expect(
      durationSeconds('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'),
    ).toBeUndefined();
  });

  it('computes positive duration in whole seconds', () => {
    expect(
      durationSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z'),
    ).toBe(600);
  });
});

describe('computePrTimingParts', () => {
  const valid = {
    created_at: '2026-01-01T00:00:00Z',
    ci_started_at: '2026-01-01T00:10:00Z',
    ci_completed_at: '2026-01-01T01:00:00Z',
    merged_at: '2026-01-01T02:00:00Z',
  };

  it('derives queue/ciRuntime/review/endToEnd from raw timestamps', () => {
    const parts = computePrTimingParts(valid);
    expect(parts.queue).toBe(600);
    expect(parts.ciRuntime).toBe(3000);
    expect(parts.review).toBe(3600);
    expect(parts.endToEnd).toBe(600 + 3000 + 3600);
    expect(parts.forcedMerge).toBe(false);
    expect(parts.invalidTiming).toBe(false);
  });

  it('flags forced merge (merged before CI completed)', () => {
    const parts = computePrTimingParts({
      ...valid,
      merged_at: '2026-01-01T00:30:00Z', // before ci_completed_at
    });
    expect(parts.forcedMerge).toBe(true);
  });

  it('excludes partial CI history from forced-merge eligibility', () => {
    // no ci_completed_at → cannot determine forced merge
    const parts = computePrTimingParts({
      created_at: '2026-01-01T00:00:00Z',
      ci_started_at: '2026-01-01T00:10:00Z',
      merged_at: '2026-01-01T02:00:00Z',
    });
    expect(parts.forcedMerge).toBe(false);
  });

  it('marks invalid timing when CI ran but timestamps are malformed', () => {
    const parts = computePrTimingParts({
      created_at: '2026-01-01T00:00:00Z',
      ci_started_at: '2026-01-01T00:10:00Z',
      ci_completed_at: '2026-01-01T00:05:00Z', // negative → invalid
      merged_at: '2026-01-01T02:00:00Z',
    });
    expect(parts.ciRuntime).toBeUndefined();
    expect(parts.invalidTiming).toBe(true);
  });
});

describe('machineHours', () => {
  it('computes Job Runtime × Resource Count ÷ 3600', () => {
    expect(machineHours(3600, 4)).toBeCloseTo(4);
    expect(machineHours(7200, 2)).toBeCloseTo(4);
  });

  it('returns undefined when Resource Count is missing or non-positive', () => {
    expect(machineHours(3600, undefined)).toBeUndefined();
    expect(machineHours(3600, 0)).toBeUndefined();
    expect(machineHours(3600, -1)).toBeUndefined();
  });

  it('returns undefined when Job Runtime is missing or invalid', () => {
    expect(machineHours(undefined, 4)).toBeUndefined();
    expect(machineHours(-10, 4)).toBeUndefined();
  });
});

describe('summarizeMachineHoursByResourceModel', () => {
  it('groups by model and counts unknown-cost samples separately', () => {
    const summary = summarizeMachineHoursByResourceModel([
      { resourceModel: 'npu-a3', resourceCount: 4, runtimeSeconds: 3600 },
      { resourceModel: 'npu-a3', resourceCount: 4, runtimeSeconds: 3600 },
      { resourceModel: 'npu-a2', resourceCount: 2, runtimeSeconds: 3600 },
      { resourceModel: null, resourceCount: undefined, runtimeSeconds: 3600 },
    ]);
    const a3 = summary.find((s) => s.resourceModel === 'npu-a3')!;
    const a2 = summary.find((s) => s.resourceModel === 'npu-a2')!;
    const unknown = summary.find((s) => s.resourceModel === 'unknown')!;
    expect(a3.machineHours).toBeCloseTo(8);
    expect(a3.jobCount).toBe(2);
    expect(a2.machineHours).toBeCloseTo(2);
    expect(unknown.machineHours).toBe(0);
    expect(unknown.unknownCostCount).toBe(1);
  });
});
