import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildEnrichedRows,
  buildPrCards,
  buildPrDashboardResult,
  buildRunsCards,
  buildRunsDashboardResult,
  classifyResourceClass,
  GPU_LABEL_PATTERN,
  NPU_LABEL_PATTERN,
  type PrMetricRow,
  type PrSeriesPoint,
} from './dashboard-read-model';

function row(overrides: Partial<PrMetricRow> = {}): PrMetricRow {
  return {
    pr_metric_id: 1,
    repo_id: 1,
    pr_number: 1,
    title: 't',
    html_url: 'https://example.com/1',
    branch: 'main',
    author: 'a',
    state: 'closed',
    conclusion: 'success',
    created_at: '2026-01-01T00:00:00Z',
    ci_started_at: '2026-01-01T00:10:00Z',
    ci_completed_at: '2026-01-01T01:00:00Z',
    merged_at: '2026-01-01T02:00:00Z',
    partial_ci_history: 0,
    ...overrides,
  };
}

const REPO_ROWS = [{ id: 1, key: 'owner/repo' }];

describe('buildEnrichedRows', () => {
  it('maps repo_id to repoKey and computes timing parts', () => {
    const enriched = buildEnrichedRows([row()], REPO_ROWS);
    expect(enriched[0].repoKey).toBe('owner/repo');
    expect(enriched[0].timing).not.toHaveProperty('queue');
    expect(enriched[0].timing.ciRuntime).toBe(3000);
  });
});

describe('classifyResourceClass', () => {
  it('a repo without GPU hardware must not show a GPU badge: CPU-only workflows classify as neither', () => {
    // vllm-ascend lint/setup jobs used to render "GPU ✓" under the old
    // "not-NPU implies GPU/other" catch-all. Positive evidence is now required.
    expect(classifyResourceClass(null, '["ubuntu-latest"]')).toBeNull();
    expect(classifyResourceClass(null, '["self-hosted"]')).toBeNull();
    expect(classifyResourceClass('linux-aarch64-cpu', '["linux-aarch64-cpu-24"]')).toBeNull();
  });

  it('NPU likewise requires NPU evidence; bare a2 tokens never classify NPU', () => {
    expect(classifyResourceClass(null, '["macos-latest"]')).toBeNull();
    // gcp-a2-highgpu is a GPU machine type: the bare a2 in its name must not
    // leak into the NPU class.
    expect(classifyResourceClass(null, '["gcp-a2-highgpu-2g-run-1-1","variant-vllm"]')).toBe('gpu');
  });

  it('classifies the governed NPU label families', () => {
    for (const labels of [
      '["linux-aarch64-a3-800i-8-cn12-001"]',
      '["self-hosted","910b-8"]',
      '["linux-amd64-a5-4"]',
      '["linux-aarch64-a2b4-2"]',
      '["nightly-a3"]',
    ]) {
      expect(classifyResourceClass(null, labels)).toBe('npu');
    }
    expect(classifyResourceClass('linux-aarch64-a3', null)).toBe('npu');
  });

  it('classifies explicit GPU evidence families', () => {
    for (const labels of [
      '["1-gpu-5090"]',
      '["nvidia-h100-1"]',
      '["self-hosted","l20-8"]',
      '["uv_cu130_dev5"]',
      '["self-hosted","amd","gfx942"]',
      '["gcp-a2-highgpu-2g-run-1-1"]',
    ]) {
      expect(classifyResourceClass(null, labels)).toBe('gpu');
    }
  });

  it('NPU evidence wins when a workflow mixes classes', () => {
    expect(classifyResourceClass(null, '["linux-amd64-a5-4","nvidia"]')).toBe('npu');
  });

  it('patterns never match bare amd64 platform tokens', () => {
    // linux-amd64-* is a platform prefix, not GPU evidence; the GPU pattern must
    // not contain the bare token amd and the NPU pattern must not match gcp-a2.
    const npu = new RegExp(NPU_LABEL_PATTERN, 'i');
    const gpu = new RegExp(GPU_LABEL_PATTERN, 'i');
    expect(gpu.test('linux-amd64-a5-4')).toBe(false);
    expect(npu.test('gcp-a2-highgpu-2g-run-1-1')).toBe(false);
  });
});

describe('runs tab', () => {
  it('builds cards with success rate, percentiles and event breakdown', () => {
    const cards = buildRunsCards({
      total: 100,
      success: 70,
      terminal: 80,
      p50RuntimeSeconds: 120,
      p90RuntimeSeconds: 480,
      events: [
        { event: 'pull_request', count: 60 },
        { event: 'repository_dispatch', count: 40 },
      ],
    });
    expect(cards.totalAttempts).toBe(100);
    expect(cards.successRate).toBeCloseTo(87.5);
    expect(cards.p50Runtime).toBe(120);
    expect(cards.p90Runtime).toBe(480);
    expect(cards.eventBreakdown).toHaveLength(2);
  });

  it('success rate is zero when nothing is terminal, not a division crash', () => {
    expect(buildRunsCards({ total: 5, success: 0, terminal: 0, p50RuntimeSeconds: null, p90RuntimeSeconds: null, events: [] }).successRate).toBe(0);
  });

  it('paginates server-side: totalRows from stats, truncated beyond the page', () => {
    const result = buildRunsDashboardResult(
      [{ repoKey: 'o/r', runId: 1, runAttempt: 1, workflowFile: 'ci.yml', event: 'repository_dispatch', status: 'completed', conclusion: 'success', createdAt: '2026-11-20T01:00:00Z', queueDurationSeconds: 0, runtimeSeconds: 60, runUrl: 'https://github.com/o/r/actions/runs/1' }],
      [{ date: '2026-11-20', count: 41 }],
      { totalAttempts: 41, successRate: 100, eventBreakdown: [{ event: 'repository_dispatch', count: 41 }] },
      { page: 1, pageSize: 20, observationLimit: 500 },
    );
    expect(result.tab).toBe('runs');
    expect(result.totalRows).toBe(41);
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.series).toEqual([{ date: '2026-11-20', count: 41 }]);
  });
});

describe('buildPrCards', () => {
  it('computes stats over the full filtered population and forced-merge rate', () => {
    const enriched = buildEnrichedRows(
      [
        row({ pr_number: 1 }),
        row({ pr_number: 2, merged_at: '2026-01-01T00:30:00Z' }), // forced merge
      ],
      REPO_ROWS,
    );
    const cards = buildPrCards(enriched);
    expect(cards.mergedPrCount).toBe(2);
    expect(cards.eligibleForcedMergeCount).toBe(2);
    expect(cards.forcedMergeRate).toBe(50);
    expect(cards.ciRuntime.sampleCount).toBe(2);
  });

  it('excludes invalid timing from duration stats but keeps them in counts', () => {
    const enriched = buildEnrichedRows(
      [
        row({ pr_number: 1 }),
        row({
          pr_number: 2,
          ci_completed_at: '2026-01-01T00:05:00Z', // negative ci runtime → invalid
        }),
      ],
      REPO_ROWS,
    );
    const cards = buildPrCards(enriched);
    expect(cards.mergedPrCount).toBe(2);
    expect(cards.ciRuntime.sampleCount).toBe(1); // only the valid one
  });
});

describe('buildPrDashboardResult', () => {
  it('maps merge-time NPU/GPU CI status onto rows keyed by pr_metric_id', () => {
    const enriched = buildEnrichedRows(
      [row({ pr_metric_id: 7, pr_number: 1 }), row({ pr_metric_id: 8, pr_number: 2 })],
      REPO_ROWS,
    );
    const result = buildPrDashboardResult(enriched, [], {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    }, [], new Map([
      [7, { npuConclusion: 'failure', gpuConclusion: 'success' }],
      [8, { npuConclusion: null, gpuConclusion: null }],
    ]));
    const first = result.rows.find((r) => r.prNumber === 1)!;
    expect(first.npuCiConclusion).toBe('failure');
    expect(first.gpuCiConclusion).toBe('success');
    const second = result.rows.find((r) => r.prNumber === 2)!;
    expect(second.npuCiConclusion).toBeNull();
    expect(second.gpuCiConclusion).toBeNull();
  });

  it('maps SQL event-sweep job counts onto the capped series by index', () => {
    const enriched = buildEnrichedRows([row({ pr_number: 1 })], REPO_ROWS);
    const runSeries: PrSeriesPoint[] = [
      { date: '2026-01-01T00:10:00Z', prNumber: 1, repoKey: 'a/b', ciRuntime: 100, conclusion: 'success' },
      { date: '2026-01-02T00:10:00Z', prNumber: 1, repoKey: 'a/b', ciRuntime: 200, conclusion: 'success' },
      { date: '2026-01-03T00:10:00Z', prNumber: 1, repoKey: 'a/b', ciRuntime: 300, conclusion: 'failure' },
    ];
    const result = buildPrDashboardResult(enriched, runSeries, {
      page: 1,
      pageSize: 20,
      observationLimit: 2,
    }, [
      { pendingJobs: 3, runningJobs: 7 },
      { pendingJobs: 1, runningJobs: 4 },
    ]);
    expect(result.series).toEqual([
      { date: '2026-01-01T00:10:00Z', prNumber: 1, repoKey: 'a/b', ciRuntime: 100, conclusion: 'success', pendingJobs: 3, runningJobs: 7 },
      { date: '2026-01-02T00:10:00Z', prNumber: 1, repoKey: 'a/b', ciRuntime: 200, conclusion: 'success', pendingJobs: 1, runningJobs: 4 },
    ]);
  });

  it('caps chart/table observations at the limit and reports truncation', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({
        pr_number: i + 1,
        merged_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T02:00:00Z`,
      }),
    );
    const enriched = buildEnrichedRows(rows, REPO_ROWS);
    const result = buildPrDashboardResult(enriched, [], {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.displayedObservationCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.cards.mergedPrCount).toBe(600); // full population
    expect(result.series).toHaveLength(0); // no workflow-attempt chart inputs supplied
    expect(result.totalRows).toBe(500);
  });

  it('paginates the table over the bounded observations', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ pr_number: i + 1 }),
    );
    const enriched = buildEnrichedRows(rows, REPO_ROWS);
    const page1 = buildPrDashboardResult(enriched, [], {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const page2 = buildPrDashboardResult(enriched, [], {
      page: 2,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].prNumber).toBe(1);
    expect(page2.rows[0].prNumber).toBe(21);
  });

  it('orders observations newest-first by merged_at', () => {
    const rows = [
      row({ pr_number: 1, merged_at: '2026-01-01T00:00:00Z' }),
      row({ pr_number: 2, merged_at: '2026-01-05T00:00:00Z' }),
      row({ pr_number: 3, merged_at: '2026-01-03T00:00:00Z' }),
    ];
    const enriched = buildEnrichedRows(rows, REPO_ROWS);
    const result = buildPrDashboardResult(enriched, [], {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows.map((r) => r.prNumber)).toEqual([2, 3, 1]);
  });

  it('reports partial-history count in quality', () => {
    const enriched = buildEnrichedRows(
      [row({ pr_number: 1 }), row({ pr_number: 2, partial_ci_history: 1 })],
      REPO_ROWS,
    );
    const result = buildPrDashboardResult(enriched, [], {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.quality.partialHistorySamples).toBe(1);
  });
});
