import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildJobCards,
  buildJobDashboardResult,
  buildQueueCards,
  buildQueueDashboardResult,
  type DailyCountPoint,
  type JobGroupRow,
  type JobPopulationStats,
  type QueueDailyPoint,
  type QueueGroupRow,
  type QueuePopulationStats,
} from './dashboard-read-model';

function jobStats(overrides: Partial<JobPopulationStats> = {}): JobPopulationStats {
  return {
    totalJobs: 0,
    terminalCount: 0,
    successCount: 0,
    p50TotalDuration: null,
    p90TotalDuration: null,
    unknownResourceSamples: 0,
    ...overrides,
  };
}

function jobGroup(overrides: Partial<JobGroupRow> = {}): JobGroupRow {
  return {
    repoKey: 'owner/repo',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    jobName: 'build',
    resourceModel: 'npu-a3',
    machineHours: 4,
    unknownCostCount: 0,
    executionCount: 1,
    avgJobTotalDuration: 3600,
    successCount: 1,
    terminalCount: 1,
    latestDate: '2026-01-01',
    ...overrides,
  };
}

function queueStats(overrides: Partial<QueuePopulationStats> = {}): QueuePopulationStats {
  return {
    sampleCount: 0,
    p50QueueDuration: null,
    p90QueueDuration: null,
    maxQueueDuration: null,
    overOneHourCount: 0,
    invalidTimingSamples: 0,
    distinctResourceModelCount: 0,
    unknownResourceSamples: 0,
    ...overrides,
  };
}

function queueGroup(overrides: Partial<QueueGroupRow> = {}): QueueGroupRow {
  return {
    repoKey: 'owner/repo',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    jobName: 'build',
    resourceModel: 'npu-a3',
    executionCount: 1,
    queueP90: 120,
    successCount: 1,
    terminalCount: 1,
    latestDate: '2026-01-01',
    ...overrides,
  };
}

const PAGE = { page: 1, pageSize: 20, observationLimit: 500 };

describe('buildJobCards', () => {
  it('computes success rate over terminal only and passes SQL percentiles through', () => {
    const stats = jobStats({
      totalJobs: 3,
      terminalCount: 2,
      successCount: 1,
      p50TotalDuration: 100,
      p90TotalDuration: 200,
    });
    const cards = buildJobCards(stats, [], false);
    expect(cards.totalJobs).toBe(3);
    expect(cards.successRate).toBe(50);
    expect(cards.p50TotalDuration).toBe(100);
    expect(cards.p90TotalDuration).toBe(200);
  });

  it('returns undefined percentiles when SQL reports no samples', () => {
    const cards = buildJobCards(jobStats({ totalJobs: 1 }), [], false);
    expect(cards.p50TotalDuration).toBeUndefined();
    expect(cards.p90TotalDuration).toBeUndefined();
  });

  it('reports top-Machine-Hour job only for a single repo, summed across models', () => {
    const groups = [
      jobGroup({ jobName: 'a', machineHours: 4 }),
      jobGroup({ jobName: 'b', machineHours: 8 }),
      jobGroup({ jobName: 'b', resourceModel: 'npu-a2', machineHours: 4 }),
    ];
    expect(buildJobCards(jobStats(), groups, false).topJob).toBeUndefined();
    expect(buildJobCards(jobStats(), groups, true).topJob?.jobName).toBe('b');
    expect(buildJobCards(jobStats(), groups, true).topJob?.machineHours).toBe(12);
  });

  it('counts contributing repos from the group rows', () => {
    const groups = [
      jobGroup({ repoKey: 'a/b' }),
      jobGroup({ repoKey: 'a/b', resourceModel: 'npu-a2' }),
      jobGroup({ repoKey: 'c/d' }),
    ];
    expect(buildJobCards(jobStats(), groups, false).contributingRepoCount).toBe(2);
  });
});

describe('buildJobDashboardResult', () => {
  it('maps pre-aggregated job groups to table rows with terminal-only failure rate', () => {
    const groups = [
      jobGroup({ executionCount: 10, successCount: 7, terminalCount: 9, machineHours: 40, avgJobTotalDuration: 3600 }),
      jobGroup({ jobName: 'test', executionCount: 4, successCount: 4, terminalCount: 4, machineHours: 8, avgJobTotalDuration: null }),
    ];
    const result = buildJobDashboardResult(
      jobStats({ unknownResourceSamples: 2 }),
      groups,
      [],
      buildJobCards(jobStats(), groups, false),
      false,
      PAGE,
    );
    expect(result.rows).toHaveLength(2);
    const build = result.rows.find((r) => r.jobName === 'build')!;
    expect(build.executionCount).toBe(10);
    expect(build.machineHours).toBe(40);
    expect(build.failureRate).toBeCloseTo(((9 - 7) / 9) * 100);
    expect(build.avgJobTotalDuration).toBe(3600);
    expect(result.rows.find((r) => r.jobName === 'test')!.avgJobTotalDuration).toBeUndefined();
    expect(result.quality.unknownResourceSamples).toBe(2);
  });

  it('builds a daily job-count series from the fetched points and caps it', () => {
    const dailyCounts: DailyCountPoint[] = [
      { date: '2026-01-01', key: 'a/b', count: 2 },
      { date: '2026-01-02', key: 'a/b', count: 1 },
      { date: '2026-01-02', key: 'c/d', count: 5 },
    ];
    const result = buildJobDashboardResult(jobStats(), [], dailyCounts, buildJobCards(jobStats(), [], false), false, PAGE);
    expect(result.series).toEqual([
      { date: '2026-01-01', key: 'a/b', jobs: 2 },
      { date: '2026-01-02', key: 'a/b', jobs: 1 },
      { date: '2026-01-02', key: 'c/d', jobs: 5 },
    ]);

    const capped = buildJobDashboardResult(
      jobStats(), [], dailyCounts, buildJobCards(jobStats(), [], false), false,
      { page: 1, pageSize: 20, observationLimit: 2 },
    );
    expect(capped.series).toHaveLength(2);
  });

  it('caps groups at the observation limit, paginates, and sorts newest-first', () => {
    const groups = Array.from({ length: 50 }, (_, i) =>
      jobGroup({ jobName: `job${i}`, latestDate: `2026-01-${String((i % 3) + 1).padStart(2, '0')}` }),
    );
    const cards = buildJobCards(jobStats(), groups, false);
    const page1 = buildJobDashboardResult(jobStats(), groups, [], cards, false, { page: 1, pageSize: 20, observationLimit: 500 });
    const page2 = buildJobDashboardResult(jobStats(), groups, [], cards, false, { page: 2, pageSize: 20, observationLimit: 500 });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].jobName).not.toBe(page2.rows[0].jobName);
    expect(page1.rows[0].latestDate >= page1.rows[19].latestDate).toBe(true);

    const truncated = buildJobDashboardResult(jobStats(), groups, [], cards, false, { page: 1, pageSize: 20, observationLimit: 30 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.totalRows).toBe(30);
  });

  it('returns an empty result when there are no jobs', () => {
    const cards = buildJobCards(jobStats(), [], false);
    const result = buildJobDashboardResult(jobStats(), [], [], cards, false, PAGE);
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(result.quality.unknownResourceSamples).toBe(0);
  });
});

describe('buildQueueCards', () => {
  it('passes SQL P50/P90/max through and computes share over one hour', () => {
    const stats = queueStats({
      sampleCount: 10,
      p50QueueDuration: 60,
      p90QueueDuration: 4000,
      maxQueueDuration: 7200,
      overOneHourCount: 2,
      distinctResourceModelCount: 3,
    });
    const cards = buildQueueCards(stats);
    expect(cards.p50QueueDuration).toBe(60);
    expect(cards.p90QueueDuration).toBe(4000);
    expect(cards.maxQueueDuration).toBe(7200);
    expect(cards.shareOverOneHour).toBe(20);
    expect(cards.distinctResourceModelCount).toBe(3);
  });

  it('returns undefined percentiles when no valid samples', () => {
    const cards = buildQueueCards(queueStats());
    expect(cards.p50QueueDuration).toBeUndefined();
    expect(cards.p90QueueDuration).toBeUndefined();
    expect(cards.maxQueueDuration).toBeUndefined();
    expect(cards.shareOverOneHour).toBe(0);
  });
});

describe('buildQueueDashboardResult', () => {
  it('maps queue groups with P90 passthrough and terminal-only success rate', () => {
    const groups = [
      queueGroup({ queueP90: 300, executionCount: 10, successCount: 8, terminalCount: 10 }),
      queueGroup({ jobName: 'test', queueP90: null, executionCount: 4, successCount: 0, terminalCount: 4 }),
    ];
    const stats = queueStats({ invalidTimingSamples: 3, unknownResourceSamples: 5 });
    const result = buildQueueDashboardResult(stats, groups, [], buildQueueCards(stats), PAGE);
    const build = result.rows.find((r) => r.jobName === 'build')!;
    expect(build.queueP90).toBe(300);
    expect(build.successRate).toBe(80);
    expect(result.rows.find((r) => r.jobName === 'test')!.queueP90).toBeUndefined();
    expect(result.quality.invalidTimingSamples).toBe(3);
    expect(result.quality.unknownResourceSamples).toBe(5);
  });

  it('builds a daily P90-per-model series, capped and sorted ascending', () => {
    const dailyP90: QueueDailyPoint[] = [
      { date: '2026-01-02', resourceModel: 'npu-a3', p90: 200 },
      { date: '2026-01-01', resourceModel: 'npu-a3', p90: 100 },
      { date: '2026-01-01', resourceModel: 'npu-a2', p90: 50 },
    ];
    const result = buildQueueDashboardResult(queueStats(), [], dailyP90, buildQueueCards(queueStats()), PAGE);
    expect(result.series).toEqual([
      { date: '2026-01-01', resourceModel: 'npu-a2', p90: 50 },
      { date: '2026-01-01', resourceModel: 'npu-a3', p90: 100 },
      { date: '2026-01-02', resourceModel: 'npu-a3', p90: 200 },
    ]);
  });

  it('orders rows by latest run date descending before truncation (spec §3)', () => {
    const groups = [
      queueGroup({ jobName: 'old', latestDate: '2026-01-01' }),
      queueGroup({ jobName: 'new', latestDate: '2026-01-05' }),
    ];
    const result = buildQueueDashboardResult(queueStats(), groups, [], buildQueueCards(queueStats()), PAGE);
    expect(result.rows.map((r) => r.jobName)).toEqual(['new', 'old']);
  });

  it('returns an empty result when there are no jobs', () => {
    const result = buildQueueDashboardResult(queueStats(), [], [], buildQueueCards(queueStats()), PAGE);
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(result.quality.invalidTimingSamples).toBe(0);
    expect(result.quality.unknownResourceSamples).toBe(0);
  });
});
