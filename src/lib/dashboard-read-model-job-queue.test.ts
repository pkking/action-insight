import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  buildJobCards,
  buildJobDashboardResult,
  buildQueueCards,
  buildQueueDashboardResult,
  jobGroupKey,
  type JobRow,
} from './dashboard-read-model';

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    repoKey: 'owner/repo',
    runId: 1,
    runAttempt: 1,
    jobId: 1,
    runDate: '2026-01-01',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    jobName: 'build',
    resourceModel: 'npu-a3',
    resourceCount: 4,
    queueDurationSeconds: 120,
    runtimeSeconds: 3600,
    totalDurationSeconds: 3720,
    jobConclusion: 'success',
    ...overrides,
  };
}

describe('buildJobCards', () => {
  it('counts all jobs and computes success rate over terminal only', () => {
    const cards = buildJobCards(
      [
        job({ jobId: 1, jobConclusion: 'success' }),
        job({ jobId: 2, jobConclusion: 'failure' }),
        job({ jobId: 3, jobConclusion: null }), // non-terminal
      ],
      false,
    );
    expect(cards.totalJobs).toBe(3);
    expect(cards.successRate).toBe(50);
    expect(cards.contributingRepoCount).toBe(1);
  });

  it('computes P50/P90 over successful Job Total Duration', () => {
    const cards = buildJobCards(
      [
        job({ jobConclusion: 'success', totalDurationSeconds: 100 }),
        job({ jobConclusion: 'success', totalDurationSeconds: 200 }),
        job({ jobConclusion: 'failure', totalDurationSeconds: 9999 }),
      ],
      false,
    );
    expect(cards.p50TotalDuration).toBe(100);
    expect(cards.p90TotalDuration).toBe(200);
  });

  it('reports top-Machine-Hour job only for a single repo', () => {
    const rows = [
      job({ jobName: 'a', runtimeSeconds: 3600, resourceCount: 4 }),
      job({ jobName: 'b', runtimeSeconds: 7200, resourceCount: 4 }),
    ];
    expect(buildJobCards(rows, false).topJob).toBeUndefined();
    expect(buildJobCards(rows, true).topJob?.jobName).toBe('b');
  });
});

describe('jobGroupKey', () => {
  it('keeps equal job names in different workflows distinct', () => {
    const a = jobGroupKey(job({ workflowFile: 'ci.yml', jobName: 'build' }));
    const b = jobGroupKey(job({ workflowFile: 'e2e.yml', jobName: 'build' }));
    expect(a).not.toBe(b);
  });
  it('keeps equal job names across resource models distinct', () => {
    const a = jobGroupKey(job({ resourceModel: 'npu-a3', jobName: 'build' }));
    const b = jobGroupKey(job({ resourceModel: 'npu-a2', jobName: 'build' }));
    expect(a).not.toBe(b);
  });
});

describe('buildJobDashboardResult', () => {
  it('groups by (repo, workflow_file, workflow_ref, job_name, resource_model)', () => {
    const rows = [
      job({ runId: 1, jobId: 1, resourceModel: 'npu-a3' }),
      job({ runId: 1, jobId: 2, resourceModel: 'npu-a2' }),
      job({ runId: 2, jobId: 3, resourceModel: 'npu-a3' }),
    ];
    const cards = buildJobCards(rows, false);
    const result = buildJobDashboardResult(rows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(2);
    const a3 = result.rows.find((r) => r.resourceModel === 'npu-a3')!;
    expect(a3.executionCount).toBe(2);
    expect(a3.machineHours).toBe(8);
  });

  it('builds a daily job-count series per repo (all repos)', () => {
    const rows = [
      job({ runId: 1, runDate: '2026-01-01', repoKey: 'a/b' }),
      job({ runId: 2, runDate: '2026-01-01', repoKey: 'a/b' }),
      job({ runId: 3, runDate: '2026-01-02', repoKey: 'c/d' }),
    ];
    const cards = buildJobCards(rows, false);
    const result = buildJobDashboardResult(rows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.series).toEqual([
      { date: '2026-01-01', key: 'a/b', jobs: 2 },
      { date: '2026-01-02', key: 'c/d', jobs: 1 },
    ]);
  });

  it('caps groups at the observation limit and reports truncation', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, jobName: `j${i}` }),
    );
    const cards = buildJobCards(rows, false);
    const result = buildJobDashboardResult(rows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.truncated).toBe(true);
    expect(result.displayedObservationCount).toBe(500);
  });

  it('counts unknown-cost jobs in quality', () => {
    const rows = [
      job({ jobId: 1, resourceCount: 4 }),
      job({ jobId: 2, resourceCount: 0 }),
    ];
    const cards = buildJobCards(rows, false);
    const result = buildJobDashboardResult(rows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.quality.unknownResourceSamples).toBe(1);
    expect(result.rows[0].unknownCostCount).toBe(1);
  });

  it('paginates the table over the bounded groups', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, jobName: `j${i}` }),
    );
    const cards = buildJobCards(rows, false);
    const page1 = buildJobDashboardResult(rows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const page2 = buildJobDashboardResult(rows, cards, false, {
      page: 2,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].jobName).not.toBe(page2.rows[0].jobName);
  });
});

describe('buildQueueCards', () => {
  it('computes P50/P90/max over valid queue samples and share over one hour', () => {
    const rows = [
      job({ queueDurationSeconds: 100 }),
      job({ queueDurationSeconds: 5000 }),
      job({ queueDurationSeconds: -1 }), // invalid, excluded
      job({ queueDurationSeconds: null }), // missing, excluded
    ];
    const cards = buildQueueCards(rows);
    expect(cards.p50QueueDuration).toBe(100);
    expect(cards.p90QueueDuration).toBe(5000);
    expect(cards.maxQueueDuration).toBe(5000);
    // 1 of 2 valid samples > 3600s
    expect(cards.shareOverOneHour).toBe(50);
    expect(cards.distinctResourceModelCount).toBe(1);
  });

  it('returns undefined percentiles when no valid samples', () => {
    const cards = buildQueueCards([job({ queueDurationSeconds: null })]);
    expect(cards.p50QueueDuration).toBeUndefined();
    expect(cards.p90QueueDuration).toBeUndefined();
    expect(cards.maxQueueDuration).toBeUndefined();
    expect(cards.shareOverOneHour).toBe(0);
  });
});

describe('buildQueueDashboardResult', () => {
  it('builds a daily P90-per-resource-model series from valid samples', () => {
    const rows = [
      job({ runId: 1, runDate: '2026-01-01', resourceModel: 'npu-a3', queueDurationSeconds: 100 }),
      job({ runId: 2, runDate: '2026-01-01', resourceModel: 'npu-a3', queueDurationSeconds: 300 }),
      job({ runId: 3, runDate: '2026-01-01', resourceModel: 'npu-a2', queueDurationSeconds: 50 }),
      job({ runId: 4, runDate: '2026-01-01', resourceModel: 'npu-a3', queueDurationSeconds: -1 }), // invalid
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const a3 = result.series.find((p) => p.resourceModel === 'npu-a3')!;
    // sorted [100, 300]; P90 = index ceil(2*0.9)-1 = 1 → 300
    expect(a3.p90).toBe(300);
    const a2 = result.series.find((p) => p.resourceModel === 'npu-a2')!;
    expect(a2.p90).toBe(50);
  });

  it('filters the series by resourceModel when provided', () => {
    const rows = [
      job({ runDate: '2026-01-01', resourceModel: 'npu-a3', queueDurationSeconds: 100 }),
      job({ runDate: '2026-01-01', resourceModel: 'npu-a2', queueDurationSeconds: 200 }),
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
      resourceModel: 'npu-a3',
    });
    expect(result.series.every((p) => p.resourceModel === 'npu-a3')).toBe(true);
  });

  it('groups the table by (repo, workflow, ref, job_name, resource_model)', () => {
    const rows = [
      job({ runId: 1, jobId: 1, jobName: 'build', resourceModel: 'npu-a3', queueDurationSeconds: 100 }),
      job({ runId: 2, jobId: 2, jobName: 'build', resourceModel: 'npu-a3', queueDurationSeconds: 300 }),
      job({ runId: 3, jobId: 3, jobName: 'test', resourceModel: 'npu-a3', queueDurationSeconds: 50 }),
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(2);
    const build = result.rows.find((r) => r.jobName === 'build')!;
    expect(build.executionCount).toBe(2);
    // sorted [100, 300]; P90 = 300
    expect(build.queueP90).toBe(300);
  });

  it('counts invalid/missing queue durations in quality', () => {
    const rows = [
      job({ queueDurationSeconds: 100 }),
      job({ queueDurationSeconds: -1 }),
      job({ queueDurationSeconds: null }),
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.quality.invalidTimingSamples).toBe(2);
  });

  it('counts missing resourceModel in unknownResourceSamples separately from invalid timing', () => {
    const rows = [
      job({ resourceModel: 'npu-a3', queueDurationSeconds: 100 }),
      job({ resourceModel: null, queueDurationSeconds: 200 }), // missing model
      job({ resourceModel: 'npu-a2', queueDurationSeconds: -1 }), // invalid queue
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    // invalid queue durations only (not duplicated into unknownResourceSamples)
    expect(result.quality.invalidTimingSamples).toBe(1);
    // jobs missing a resourceModel are excluded from the per-model series
    expect(result.quality.unknownResourceSamples).toBe(1);
  });

  it('orders rows by latest run date descending before truncation (spec §3)', () => {
    const rows = [
      // older group with the higher queueP90
      job({ runId: 1, runDate: '2026-01-01', jobName: 'old-high', queueDurationSeconds: 900 }),
      // newer group with the lower queueP90
      job({ runId: 2, runDate: '2026-01-02', jobName: 'new-low', queueDurationSeconds: 50 }),
    ];
    const cards = buildQueueCards(rows);
    const result = buildQueueDashboardResult(rows, cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 1, // truncate to the newest 1
    });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // the newest-by-date group survives even though it has the lower queueP90
    expect(result.rows[0].jobName).toBe('new-low');
    expect(result.rows[0].latestDate).toBe('2026-01-02');
  });

  it('returns an empty result when there are no jobs', () => {
    const cards = buildQueueCards([]);
    const result = buildQueueDashboardResult([], cards, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
  });
});
