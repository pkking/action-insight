import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildEnrichedRows,
  buildPrCards,
  buildPrDashboardResult,
  type PrMetricRow,
} from './dashboard-read-model';

function row(overrides: Partial<PrMetricRow> = {}): PrMetricRow {
  return {
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
    expect(enriched[0].timing.queue).toBe(600);
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
  it('caps chart/table observations at the limit and reports truncation', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({
        pr_number: i + 1,
        merged_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T02:00:00Z`,
      }),
    );
    const enriched = buildEnrichedRows(rows, REPO_ROWS);
    const result = buildPrDashboardResult(enriched, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.displayedObservationCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.cards.mergedPrCount).toBe(600); // full population
    expect(result.series).toHaveLength(500);
    expect(result.totalRows).toBe(500);
  });

  it('paginates the table over the bounded observations', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ pr_number: i + 1 }),
    );
    const enriched = buildEnrichedRows(rows, REPO_ROWS);
    const page1 = buildPrDashboardResult(enriched, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const page2 = buildPrDashboardResult(enriched, {
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
    const result = buildPrDashboardResult(enriched, {
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
    const result = buildPrDashboardResult(enriched, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.quality.partialHistorySamples).toBe(1);
  });
});
