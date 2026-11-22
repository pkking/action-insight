import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { sql, release } = vi.hoisted(() => ({ sql: vi.fn(), release: vi.fn() }));
vi.mock('./db', () => ({
  query: vi.fn(async () => ({ rows: [{ id: 1 }] })),
  getDatabaseClient: vi.fn(async () => ({ query: sql, release })),
}));
vi.mock('./server-homepage-data', () => ({
  getTrackedRepoOptions: async () => [{ owner: 'o', repo: 'r', key: 'o/r' }],
}));
import { getDashboardReadModel } from './dashboard-read-model';

describe('Runs SQL pagination', () => {
  it('clamps an out-of-range page before querying and displays the last page', async () => {
    sql.mockReset();
    sql.mockResolvedValueOnce({ rows: [{ total: 41, success: 41, terminal: 41, avg_runtime: 123 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ run_id: 7, repo_id: 1, run_attempt: 1, event: 'push', status: 'completed', total_count: 41 }] });
    const result = await getDashboardReadModel({ tab: 'runs', repoKey: 'o/r', startDate: '2026-01-01', endDate: '2026-01-07', page: 99, pageSize: 20, observationLimit: 500 });
    expect(sql.mock.calls[2][0]).toMatch(/ORDER BY wa\.created_at DESC NULLS LAST, wa\.run_id DESC, wa\.run_attempt DESC/);
    expect(sql.mock.calls[2][0]).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(sql.mock.calls[2][1]).toEqual([1, '2026-01-01', '2026-01-07', 20, 40]);
    expect(sql.mock.calls[0][0]).toMatch(/AVG\(wa\.runtime_seconds\)/);
    expect(sql.mock.calls[0][0]).not.toMatch(/LIMIT|OFFSET/);
    expect(result.cards.totalAttempts).toBe(41);
    expect(result.cards.avgRuntime).toBe(123);
    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(1);
  });
});
