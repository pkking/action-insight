import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildCostCards,
  buildCostDashboardResult,
  dayCount,
  type CostDailyPoint,
  type WorkflowGroupRow,
} from './dashboard-read-model';

function group(overrides: Partial<WorkflowGroupRow> = {}): WorkflowGroupRow {
  return {
    repoKey: 'owner/repo',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    resourceModel: 'npu-a3',
    machineHours: 4,
    unknownCostCount: 0,
    attemptCount: 1,
    successCount: 1,
    terminalCount: 1,
    avgWorkflowTotalDuration: 3600,
    latestDate: '2026-01-01',
    ...overrides,
  };
}

const PAGE = { page: 1, pageSize: 20, observationLimit: 500 };

describe('buildCostCards', () => {
  it('sums Machine-Hours over SQL group rows', () => {
    const groups = [
      group({ machineHours: 4 }),
      group({ repoKey: 'other/repo', machineHours: 8 }),
    ];
    const cards = buildCostCards(groups, 0, 1, false);
    expect(cards.totalMachineHours).toBe(12);
    expect(cards.topRepo?.repoKey).toBe('other/repo');
    expect(cards.topRepo?.machineHours).toBe(8);
  });

  it('reports per-merged-PR only when the denominator is positive', () => {
    expect(buildCostCards([group({ machineHours: 8 })], 0, 1, false).machineHoursPerMergedPr).toBeUndefined();
    expect(buildCostCards([group({ machineHours: 8 })], 4, 1, false).machineHoursPerMergedPr).toBe(2);
  });

  it('uses repo count for all-repos and merged-PR count for one repo', () => {
    const groups = [group(), group({ repoKey: 'other/repo' })];
    expect(buildCostCards(groups, 7, 1, false).contributingCount).toBe(2);
    expect(buildCostCards(groups, 7, 1, true).contributingCount).toBe(7);
  });

  it('computes daily average over the inclusive day count', () => {
    expect(buildCostCards([group({ machineHours: 12 })], 0, 4, false).dailyAverageMachineHours).toBe(3);
    expect(buildCostCards([group({ machineHours: 12 })], 0, 0, false).dailyAverageMachineHours).toBe(0);
  });
});

describe('dayCount', () => {
  it('counts inclusive days', () => {
    expect(dayCount('2026-01-01', '2026-01-10')).toBe(10);
    expect(dayCount('2026-01-01', '2026-01-01')).toBe(1);
  });

  it('returns 0 for invalid/inverted ranges', () => {
    expect(dayCount('2026-01-10', '2026-01-01')).toBe(0);
  });
});

describe('buildCostDashboardResult', () => {
  it('maps groups to rows with share of filtered total and terminal-only failure rate', () => {
    const groups = [
      group({ machineHours: 30, attemptCount: 10, successCount: 7, terminalCount: 9, avgWorkflowTotalDuration: 3600 }),
      group({ resourceModel: 'npu-a2', machineHours: 10, attemptCount: 4, successCount: 4, terminalCount: 4, avgWorkflowTotalDuration: null }),
    ];
    const cards = buildCostCards(groups, 0, 1, false);
    const result = buildCostDashboardResult(groups, [], cards, PAGE);
    expect(result.rows).toHaveLength(2);
    const a3 = result.rows.find((r) => r.resourceModel === 'npu-a3')!;
    expect(a3.machineHours).toBe(30);
    expect(a3.shareOfTotal).toBe(75);
    expect(a3.attemptCount).toBe(10);
    expect(a3.failureRate).toBeCloseTo(((9 - 7) / 9) * 100);
    expect(a3.avgWorkflowTotalDuration).toBe(3600);
    expect(result.rows.find((r) => r.resourceModel === 'npu-a2')!.avgWorkflowTotalDuration).toBeUndefined();
  });

  it('counts unknown-cost jobs in quality, never as machine-hours', () => {
    const groups = [
      group({ machineHours: 4, unknownCostCount: 0 }),
      group({ resourceModel: 'unknown', machineHours: 0, unknownCostCount: 2 }),
    ];
    const cards = buildCostCards(groups, 0, 1, false);
    const result = buildCostDashboardResult(groups, [], cards, PAGE);
    expect(cards.totalMachineHours).toBe(4);
    expect(result.quality.unknownResourceSamples).toBe(2);
    expect(result.rows.find((r) => r.resourceModel === 'unknown')!.unknownCostCount).toBe(2);
  });

  it('caps groups at the observation limit and paginates', () => {
    const groups = Array.from({ length: 50 }, (_, i) =>
      group({ workflowFile: `wf${i}.yml` }),
    );
    const cards = buildCostCards(groups, 0, 1, false);
    const page1 = buildCostDashboardResult(groups, [], cards, { page: 1, pageSize: 20, observationLimit: 500 });
    const page2 = buildCostDashboardResult(groups, [], cards, { page: 2, pageSize: 20, observationLimit: 500 });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].workflowFile).not.toBe(page2.rows[0].workflowFile);

    const truncated = buildCostDashboardResult(groups, [], cards, { page: 1, pageSize: 20, observationLimit: 30 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.totalRows).toBe(30);
  });

  it('orders groups newest-first by latest contributing run date', () => {
    const groups = [
      group({ workflowFile: 'old.yml', latestDate: '2026-01-01' }),
      group({ workflowFile: 'new.yml', latestDate: '2026-01-05' }),
    ];
    const cards = buildCostCards(groups, 0, 1, false);
    const result = buildCostDashboardResult(groups, [], cards, PAGE);
    expect(result.rows.map((r) => r.workflowFile)).toEqual(['new.yml', 'old.yml']);
  });

  it('builds a daily per-repo series from the fetched points, capped', () => {
    const dailySeries: CostDailyPoint[] = [
      { date: '2026-01-02', repoKey: 'a/b', machineHours: 2 },
      { date: '2026-01-01', repoKey: 'a/b', machineHours: 1 },
      { date: '2026-01-01', repoKey: 'c/d', machineHours: 5 },
    ];
    const cards = buildCostCards([], 0, 1, false);
    const result = buildCostDashboardResult([], dailySeries, cards, PAGE);
    expect(result.series).toEqual([
      { date: '2026-01-01', repoKey: 'a/b', machineHours: 1 },
      { date: '2026-01-01', repoKey: 'c/d', machineHours: 5 },
      { date: '2026-01-02', repoKey: 'a/b', machineHours: 2 },
    ]);

    const capped = buildCostDashboardResult([], dailySeries, cards, { page: 1, pageSize: 20, observationLimit: 2 });
    expect(capped.series).toHaveLength(2);
  });

  it('returns an empty result with no quality noise when there are no jobs', () => {
    const cards = buildCostCards([], 0, 1, false);
    const result = buildCostDashboardResult([], [], cards, PAGE);
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(result.quality.unknownResourceSamples).toBe(0);
    expect(cards.totalMachineHours).toBe(0);
  });
});
