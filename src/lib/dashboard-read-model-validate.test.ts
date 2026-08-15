import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only'; stub it for jsdom tests of the pure validators.
vi.mock('server-only', () => ({}));

import {
  parsePrDashboardQuery,
  validateDashboardQuery,
  type DashboardQuery,
} from './dashboard-read-model';

function baseQuery(overrides: Partial<DashboardQuery> = {}): DashboardQuery {
  return {
    tab: 'pr',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    repoKey: undefined,
    page: 1,
    pageSize: 20,
    observationLimit: 500,
    ...overrides,
  };
}

describe('validateDashboardQuery', () => {
  it('accepts a well-formed PR query', () => {
    expect(() => validateDashboardQuery(baseQuery())).not.toThrow();
  });

  it('rejects an unknown tab', () => {
    expect(() => validateDashboardQuery(baseQuery({ tab: 'bogus' as never }))).toThrow(
      /Invalid dashboard tab/,
    );
  });

  it('rejects malformed dates', () => {
    expect(() => validateDashboardQuery(baseQuery({ startDate: '2026-1-1' }))).toThrow(
      /yyyy-mm-dd/,
    );
  });

  it('rejects startDate after endDate', () => {
    expect(() =>
      validateDashboardQuery(baseQuery({ startDate: '2026-02-01', endDate: '2026-01-01' })),
    ).toThrow(/after/);
  });

  it('rejects non-positive page', () => {
    expect(() => validateDashboardQuery(baseQuery({ page: 0 }))).toThrow(/page/);
  });

  it('rejects non-positive pageSize', () => {
    expect(() => validateDashboardQuery(baseQuery({ pageSize: 0 }))).toThrow(/pageSize/);
  });
});

describe('parsePrDashboardQuery', () => {
  it('defaults to a 1-day window ending today when no params', () => {
    const q = parsePrDashboardQuery(new URLSearchParams());
    expect(q.tab).toBe('pr');
    expect(q.repoKey).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
    expect(q.observationLimit).toBe(500);
    // endDate defaults to today; startDate defaults to ~1 day back.
    expect(q.startDate <= q.endDate).toBe(true);
  });

  it('honours explicit repo, dates, and page', () => {
    const params = new URLSearchParams({
      repo: 'owner/repo',
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      page: '3',
    });
    const q = parsePrDashboardQuery(params);
    expect(q.repoKey).toBe('owner/repo');
    expect(q.startDate).toBe('2026-03-01');
    expect(q.endDate).toBe('2026-03-10');
    expect(q.page).toBe(3);
  });

  it('falls back to page 1 for invalid page input', () => {
    const q = parsePrDashboardQuery(new URLSearchParams({ page: 'abc' }));
    expect(q.page).toBe(1);
  });
});
