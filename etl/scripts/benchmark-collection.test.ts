import { describe, expect, it, vi } from 'vitest';
import {
  aggregateBenchmarkComparisons,
  compareBenchmarkResults,
  createInstrumentedClient,
  formatBenchmarkReport,
  parseBenchmarkCliOptions,
  type BenchmarkComparison,
  type CollectionMetrics,
} from './benchmark-collection.ts';

describe('parseBenchmarkCliOptions', () => {
  it('defaults to representative repositories and 3 days', () => {
    const opts = parseBenchmarkCliOptions([]);
    expect(opts.representatives).toBe(true);
    expect(opts.all).toBe(false);
    expect(opts.days).toBe(3);
    expect(opts.json).toBe(false);
  });

  it('parses specific repo and days flags', () => {
    const opts = parseBenchmarkCliOptions(['--repo', 'sgl-project/sglang', '--days', '5', '--json']);
    expect(opts.repo).toBe('sgl-project/sglang');
    expect(opts.days).toBe(5);
    expect(opts.json).toBe(true);
    expect(opts.all).toBe(false);
  });

  it('parses --all flag', () => {
    const opts = parseBenchmarkCliOptions(['--all']);
    expect(opts.all).toBe(true);
    expect(opts.representatives).toBe(false);
  });
});

describe('createInstrumentedClient', () => {
  it('instruments GitHub REST requests by category and elapsed time', async () => {
    const mockRequest = vi.fn(async (route: string) => {
      if (route.includes('/304')) {
        const err = new Error('Not Modified') as Error & { status: number };
        err.status = 304;
        throw err;
      }
      return { data: {}, headers: {} };
    });

    const fakeOctokit = { request: mockRequest } as never;
    const instrumented = createInstrumentedClient(fakeOctokit);

    await instrumented.client.request('GET /repos/owner/repo/actions/workflows/ci.yml/runs');
    await instrumented.client.request('GET /repos/owner/repo/actions/runs/123/jobs');
    await instrumented.client.request('GET /repos/owner/repo/actions/runs/123/attempts/2/jobs');
    await instrumented.client.request('GET /rate_limit');
    await expect(instrumented.client.request('GET /repos/owner/repo/actions/workflows/ci.yml/runs/304')).rejects.toThrow();

    const accounting = instrumented.getAccounting();
    expect(accounting.listRequests).toBe(2); // normal runs + 304 runs
    expect(accounting.jobsRequests).toBe(1);
    expect(accounting.rerunJobsRequests).toBe(1);
    expect(accounting.otherRequests).toBe(1);
    expect(accounting.conditional304s).toBe(1);
    expect(accounting.totalRequests).toBe(5);
    expect(accounting.totalRequestElapsedMs).toBeGreaterThanOrEqual(0);

    instrumented.resetAccounting();
    expect(instrumented.getAccounting().totalRequests).toBe(0);
  });
});

describe('compareBenchmarkResults', () => {
  const sampleCold: CollectionMetrics = {
    requests: {
      listRequests: 10,
      jobsRequests: 90,
      rerunJobsRequests: 10,
      conditional304s: 0,
      otherRequests: 2,
      totalRequests: 112,
      totalRequestElapsedMs: 50_000,
    },
    wallClockMs: 20_000,
    runs: 50,
    attempts: 55,
    jobs: 120,
    steps: 500,
  };

  it('computes reduction and speedup and verifies acceptance criteria', () => {
    const sampleWarm: CollectionMetrics = {
      requests: {
        listRequests: 5,
        jobsRequests: 0,
        rerunJobsRequests: 0,
        conditional304s: 5,
        otherRequests: 2,
        totalRequests: 7,
        totalRequestElapsedMs: 2_000,
      },
      wallClockMs: 1_500,
      runs: 50,
      attempts: 55,
      jobs: 120,
      steps: 500,
    };

    const result = compareBenchmarkResults('acme/repo', sampleCold, sampleWarm, 'medium');

    expect(result.requestReductionPercent).toBeCloseTo(93.75, 1);
    expect(result.wallClockSpeedupMultiplier).toBeCloseTo(13.33, 1);
    expect(result.meetsRequestReductionThreshold).toBe(true);
    expect(result.meetsSpeedupThreshold).toBe(true);
    expect(result.completenessPreserved).toBe(true);
  });

  it('fails acceptance criteria when reduction or speedup is below target', () => {
    const slowWarm: CollectionMetrics = {
      requests: {
        listRequests: 10,
        jobsRequests: 60,
        rerunJobsRequests: 0,
        conditional304s: 0,
        otherRequests: 2,
        totalRequests: 72,
        totalRequestElapsedMs: 40_000,
      },
      wallClockMs: 15_000,
      runs: 50,
      attempts: 55,
      jobs: 120,
      steps: 500,
    };

    const result = compareBenchmarkResults('acme/repo', sampleCold, slowWarm, 'medium');

    // 112 -> 72 is (112-72)/112 = 35.7% (< 50%)
    expect(result.meetsRequestReductionThreshold).toBe(false);
    // 20,000 / 15,000 = 1.33x (< 2.0x)
    expect(result.meetsSpeedupThreshold).toBe(false);
    expect(result.completenessPreserved).toBe(true);
  });

  it('detects completeness regressions when warm has missing entities', () => {
    const incompleteWarm: CollectionMetrics = {
      requests: {
        listRequests: 2,
        jobsRequests: 0,
        rerunJobsRequests: 0,
        conditional304s: 2,
        otherRequests: 1,
        totalRequests: 3,
        totalRequestElapsedMs: 500,
      },
      wallClockMs: 800,
      runs: 30, // was 50!
      attempts: 30,
      jobs: 80,
      steps: 300,
    };

    const result = compareBenchmarkResults('acme/repo', sampleCold, incompleteWarm, 'small');
    expect(result.completenessPreserved).toBe(false);
  });
});

describe('aggregateBenchmarkComparisons and formatBenchmarkReport', () => {
  it('aggregates comparisons across repositories and formats Markdown report', () => {
    const compA: BenchmarkComparison = {
      repo: 'ascend/pytorch',
      sizeCategory: 'small',
      cold: {
        requests: { listRequests: 4, jobsRequests: 20, rerunJobsRequests: 0, conditional304s: 0, otherRequests: 1, totalRequests: 25, totalRequestElapsedMs: 8_000 },
        wallClockMs: 4_000,
        runs: 10,
        attempts: 10,
        jobs: 20,
        steps: 80,
      },
      warm: {
        requests: { listRequests: 4, jobsRequests: 0, rerunJobsRequests: 0, conditional304s: 4, otherRequests: 1, totalRequests: 5, totalRequestElapsedMs: 1_000 },
        wallClockMs: 800,
        runs: 10,
        attempts: 10,
        jobs: 20,
        steps: 80,
      },
      requestReductionPercent: 80,
      wallClockSpeedupMultiplier: 5,
      meetsRequestReductionThreshold: true,
      meetsSpeedupThreshold: true,
      completenessPreserved: true,
    };

    const compB: BenchmarkComparison = {
      repo: 'sgl-project/sglang',
      sizeCategory: 'high',
      cold: {
        requests: { listRequests: 10, jobsRequests: 300, rerunJobsRequests: 20, conditional304s: 0, otherRequests: 2, totalRequests: 332, totalRequestElapsedMs: 120_000 },
        wallClockMs: 60_000,
        runs: 150,
        attempts: 160,
        jobs: 320,
        steps: 1200,
      },
      warm: {
        requests: { listRequests: 10, jobsRequests: 0, rerunJobsRequests: 0, conditional304s: 10, otherRequests: 2, totalRequests: 12, totalRequestElapsedMs: 3_000 },
        wallClockMs: 2_000,
        runs: 150,
        attempts: 160,
        jobs: 320,
        steps: 1200,
      },
      requestReductionPercent: 96.38,
      wallClockSpeedupMultiplier: 30,
      meetsRequestReductionThreshold: true,
      meetsSpeedupThreshold: true,
      completenessPreserved: true,
    };

    const aggregated = aggregateBenchmarkComparisons([compA, compB]);
    expect(aggregated.repo).toBe('All Tracked Repositories');
    expect(aggregated.cold.requests.totalRequests).toBe(357);
    expect(aggregated.warm.requests.totalRequests).toBe(17);
    expect(aggregated.requestReductionPercent).toBeGreaterThan(95);
    expect(aggregated.wallClockSpeedupMultiplier).toBeGreaterThan(20);
    expect(aggregated.meetsRequestReductionThreshold).toBe(true);
    expect(aggregated.meetsSpeedupThreshold).toBe(true);
    expect(aggregated.completenessPreserved).toBe(true);

    const report = formatBenchmarkReport([compA, compB, aggregated]);
    expect(report).toContain('# Collection Benchmark: 3-Day Historical Snapshot Comparison');
    expect(report).toContain('ascend/pytorch');
    expect(report).toContain('sgl-project/sglang');
    expect(report).toContain('All Tracked Repositories');
    expect(report).toContain('PASS');
  });
});
