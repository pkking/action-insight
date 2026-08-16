import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildCostCards,
  buildCostDashboardResult,
  costGroupKey,
  dayCount,
  type CostJobRow,
} from './dashboard-read-model';

function job(overrides: Partial<CostJobRow> = {}): CostJobRow {
  return {
    repoKey: 'owner/repo',
    runId: 1,
    runAttempt: 1,
    jobId: 1,
    runDate: '2026-01-01',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    resourceModel: 'npu-a3',
    resourceCount: 4,
    runtimeSeconds: 3600, // 1h × 4 = 4 machine-hours
    attemptConclusion: 'success',
    attemptTotalDurationSeconds: 3600,
    ...overrides,
  };
}

describe('buildCostCards', () => {
  it('sums Machine-Hours and excludes jobs without a positive Resource Count', () => {
    const rows = [
      job({ jobId: 1, runtimeSeconds: 3600, resourceCount: 4 }), // 4 mh
      job({ jobId: 2, runtimeSeconds: 3600, resourceCount: 0 }), // unknown
      job({ jobId: 3, runtimeSeconds: null, resourceCount: 4 }), // unknown (no runtime)
      job({ jobId: 4, runtimeSeconds: 1800, resourceCount: 2 }), // 1 mh
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    // 4 + 1 = 5 attributable machine-hours; queue never included.
    expect(cards.totalMachineHours).toBe(5);
    expect(cards.topRepo?.repoKey).toBe('owner/repo');
    expect(cards.topRepo?.machineHours).toBe(5);
  });

  it('reports per-merged-PR only when the denominator is positive', () => {
    expect(buildCostCards([job()], 0, 1, false).machineHoursPerMergedPr).toBeUndefined();
    expect(buildCostCards([job()], 2, 1, false).machineHoursPerMergedPr).toBe(2);
  });

  it('uses repo count for all-repos and merged-PR count for one repo', () => {
    const rows = [
      job({ repoKey: 'a/b' }),
      job({ repoKey: 'c/d' }),
    ];
    expect(buildCostCards(rows, 5, 14, false).contributingCount).toBe(2);
    expect(buildCostCards(rows, 5, 14, true).contributingCount).toBe(5);
  });

  it('computes daily average over the inclusive day count', () => {
    expect(buildCostCards([job({ runtimeSeconds: 3600, resourceCount: 4 })], 0, 14, false).dailyAverageMachineHours).toBeCloseTo(4 / 14, 6);
  });
});

describe('dayCount', () => {
  it('counts inclusive days', () => {
    expect(dayCount('2026-01-01', '2026-01-01')).toBe(1);
    expect(dayCount('2026-01-01', '2026-01-14')).toBe(14);
  });
  it('returns 0 for invalid/inverted ranges', () => {
    expect(dayCount('bad', '2026-01-14')).toBe(0);
    expect(dayCount('2026-01-14', '2026-01-01')).toBe(0);
  });
});

describe('costGroupKey', () => {
  it('keeps same-name workflows from different files/refs distinct', () => {
    const a = costGroupKey(job({ workflowFile: 'ci.yml', workflowRef: 'refs/heads/main' }));
    const b = costGroupKey(job({ workflowFile: 'ci.yml', workflowRef: 'refs/heads/dev' }));
    const c = costGroupKey(job({ workflowFile: 'e2e.yml', workflowRef: 'refs/heads/main' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('buildCostDashboardResult', () => {
  it('groups by (repo, workflow_file, workflow_ref, resource_model)', () => {
    const rows = [
      job({ runId: 1, jobId: 1, resourceModel: 'npu-a3' }),
      job({ runId: 1, jobId: 2, resourceModel: 'npu-a2' }),
      job({ runId: 2, jobId: 3, resourceModel: 'npu-a3' }), // same group as job 1
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(2);
    const a3 = result.rows.find((r) => r.resourceModel === 'npu-a3')!;
    expect(a3.attemptCount).toBe(2); // runId 1 + runId 2
    expect(a3.machineHours).toBe(8); // 2 jobs × 4 mh
  });

  it('caps groups at the observation limit and reports truncation', () => {
    // 600 distinct groups (distinct workflow files).
    const rows = Array.from({ length: 600 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, workflowFile: `wf${i}.yml`, runDate: '2026-01-01' }),
    );
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.truncated).toBe(true);
    expect(result.displayedObservationCount).toBe(500);
    expect(result.totalRows).toBe(500);
    // cards computed over the FULL population (spec §3).
    expect(cards.totalMachineHours).toBe(600 * 4);
  });

  it('counts unknown-cost jobs in quality, never as machine-hours', () => {
    const rows = [
      job({ jobId: 1, resourceCount: 4, runtimeSeconds: 3600 }),
      job({ jobId: 2, resourceCount: 0, runtimeSeconds: 3600 }),
      job({ jobId: 3, resourceCount: 4, runtimeSeconds: null }),
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(cards.totalMachineHours).toBe(4);
    expect(result.quality.unknownResourceSamples).toBe(2);
    expect(result.rows[0].unknownCostCount).toBe(2);
  });

  it('uses terminal-only denominators for failure rate', () => {
    const rows = [
      // two terminal attempts: 1 success, 1 failure; one in-progress (non-terminal)
      job({ runId: 1, jobId: 1, attemptConclusion: 'success' }),
      job({ runId: 2, jobId: 1, attemptConclusion: 'failure' }),
      job({ runId: 3, jobId: 1, attemptConclusion: null }), // status in_progress
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const row = result.rows[0];
    expect(row.attemptCount).toBe(3);
    expect(row.successCount).toBe(1);
    // failure rate = (2 terminal - 1 success) / 2 = 50%
    expect(row.failureRate).toBe(50);
  });

  it('paginates the table over the bounded groups', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, workflowFile: `wf${i}.yml` }),
    );
    const cards = buildCostCards(rows, 0, 1, false);
    const page1 = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const page2 = buildCostDashboardResult(rows, cards, {
      page: 2,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].workflowFile).not.toBe(page2.rows[0].workflowFile);
  });

  it('orders groups newest-first by latest contributing run date', () => {
    const rows = [
      job({ runId: 1, workflowFile: 'old.yml', runDate: '2026-01-01' }),
      job({ runId: 2, workflowFile: 'new.yml', runDate: '2026-01-05' }),
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows.map((r) => r.workflowFile)).toEqual(['new.yml', 'old.yml']);
  });

  it('builds a daily per-repo series from attributable jobs only', () => {
    const rows = [
      job({ runId: 1, runDate: '2026-01-01', repoKey: 'a/b', resourceCount: 4, runtimeSeconds: 3600 }),
      job({ runId: 2, runDate: '2026-01-02', repoKey: 'a/b', resourceCount: 4, runtimeSeconds: 3600 }),
      job({ runId: 3, runDate: '2026-01-02', repoKey: 'c/d', resourceCount: 2, runtimeSeconds: 3600 }),
      job({ runId: 4, runDate: '2026-01-01', repoKey: 'a/b', resourceCount: 0 }), // unknown, excluded
    ];
    const cards = buildCostCards(rows, 0, 2, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.series).toEqual([
      { date: '2026-01-01', repoKey: 'a/b', machineHours: 4 },
      { date: '2026-01-02', repoKey: 'a/b', machineHours: 4 },
      { date: '2026-01-02', repoKey: 'c/d', machineHours: 2 },
    ]);
  });

  it('returns an empty result with no quality noise when there are no jobs', () => {
    const cards = buildCostCards([], 0, 1, false);
    const result = buildCostDashboardResult([], cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(result.cards.totalMachineHours).toBe(0);
    expect(result.quality.unknownResourceSamples).toBe(0);
  });

  it('computes share of filtered total per group', () => {
    const rows = [
      job({ runId: 1, workflowFile: 'a.yml', resourceCount: 4, runtimeSeconds: 3600 }),
      job({ runId: 2, workflowFile: 'b.yml', resourceCount: 4, runtimeSeconds: 7200 }),
    ];
    const cards = buildCostCards(rows, 0, 1, false);
    const result = buildCostDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const total = result.cards.totalMachineHours; // 4 + 8 = 12
    const a = result.rows.find((r) => r.workflowFile === 'a.yml')!;
    const b = result.rows.find((r) => r.workflowFile === 'b.yml')!;
    expect(Math.round(a.shareOfTotal)).toBe(33); // 4/12
    expect(Math.round(b.shareOfTotal)).toBe(67); // 8/12
    void total;
  });
});
