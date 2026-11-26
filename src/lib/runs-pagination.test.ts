import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { sql, release, resolveRows } = vi.hoisted(() => ({
  sql: vi.fn(), release: vi.fn(), resolveRows: vi.fn(async () => ({ rows: [{ id: 1 }] })),
}));
vi.mock('./db', () => ({
  query: resolveRows,
  getDatabaseClient: vi.fn(async () => ({ query: sql, release })),
}));
vi.mock('./server-homepage-data', () => ({
  getTrackedRepoOptions: async () => [
    { owner: 'o', repo: 'r', key: 'o/r' },
    { owner: 'vllm-project', repo: 'vllm-ascend', key: 'vllm-project/vllm-ascend' },
  ],
}));
import { getDashboardReadModel } from './dashboard-read-model';

describe('Runs SQL pagination', () => {
  it('clamps an out-of-range page before querying and displays the last page', async () => {
    sql.mockReset();
    sql.mockResolvedValueOnce({ rows: [{ total: 41, success: 41, terminal: 41, avg_runtime: 123 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ run_id: 7, repo_id: 1, run_attempt: 1, event: 'push', status: 'completed', total_count: 41 }] });
    const result = await getDashboardReadModel({ tab: 'runs', repoKey: 'o/r', startDate: '2026-01-01', endDate: '2026-01-07', page: 99, pageSize: 20, observationLimit: 500 });
    expect(sql.mock.calls[3][0]).toMatch(/ORDER BY timing\.window_at DESC, wa\.run_id DESC, wa\.run_attempt DESC/);
    expect(sql.mock.calls[3][0]).toContain('CASE WHEN wa.run_attempt > 1 THEN NULL ELSE wa.queue_duration_seconds END');
    expect(sql.mock.calls[3][0]).toContain("AT TIME ZONE 'UTC'");
    expect(sql.mock.calls[3][0]).not.toMatch(/r\.date\s*[<>]/);
    expect(sql.mock.calls[3][0]).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(sql.mock.calls[3][0]).not.toMatch(/COUNT\(\*\) OVER/i);
    expect(sql.mock.calls[3][1]).toEqual([1, '2026-01-01', '2026-01-07', 20, 40]);
    expect(sql.mock.calls[0][0]).toMatch(/AVG\(wa\.runtime_seconds\)/);
    expect(sql.mock.calls[0][0]).not.toMatch(/LIMIT|OFFSET/);
    if (result.tab !== 'runs') throw new Error('Expected runs');
    expect(result.cards.totalAttempts).toBe(41);
    expect(result.cards.avgRuntime).toBe(123);
    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(1);
  });
  it('returns an empty runs result when the configured default repository is not in the database', async () => {
    resolveRows.mockResolvedValueOnce({ rows: [] });
    const result = await getDashboardReadModel({ tab: 'runs', repoKey: 'vllm-project/vllm-ascend', startDate: '2026-01-01', endDate: '2026-01-07', page: 1, pageSize: 20, observationLimit: 500 });
    expect(result.tab).toBe('runs');
    if (result.tab === 'runs') expect(result.cards.totalAttempts).toBe(0);
    expect(resolveRows).toHaveBeenLastCalledWith(expect.stringContaining('FROM repos'), ['vllm-project', 'vllm-ascend']);
  });
  it('returns all chart attempts independently of page and changes with the window', async () => {
    sql.mockReset();
    const attempts = Array.from({ length: 25 }, (_, i) => ({ repo_id: 1, run_id: String(i + 1), run_attempt: 1, plot_time: '2026-01-02T00:00:00Z', runtime_seconds: i === 0 ? null : i, outcome: i % 2 ? 'success' : 'failure' }));
    sql.mockImplementation(async (query: string, params: unknown[]) => {
      if (query.includes('AS plot_time')) return { rows: params.includes('2026-02-01') ? attempts.slice(0, 2) : attempts };
      if (query.includes('AVG(wa.runtime_seconds)')) return { rows: [{ total: 25, success: 12, terminal: 25 }] };
      return { rows: [] };
    });
    const base = { tab: 'runs' as const, repoKey: 'o/r', startDate: '2026-01-01', endDate: '2026-01-07', pageSize: 20, observationLimit: 1 };
    const first = await getDashboardReadModel({ ...base, page: 1 });
    const second = await getDashboardReadModel({ ...base, page: 2 });
    const changed = await getDashboardReadModel({ ...base, page: 1, startDate: '2026-02-01', endDate: '2026-02-07' });
    if (first.tab !== 'runs' || second.tab !== 'runs' || changed.tab !== 'runs') throw new Error('Expected runs');
    expect(first.chart.points).toHaveLength(25);
    expect(first.chart).toEqual(second.chart);
    expect(first.chart.points[0][4]).toBeNull();
    expect(changed.chart.points).toHaveLength(2);
    const query = sql.mock.calls.find(([text]) => text.includes('AS plot_time'));
    expect(query?.[0]).not.toMatch(/LIMIT|OFFSET/);
  });

});
