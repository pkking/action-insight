import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('./db', () => ({
  query: vi.fn(),
  getDatabaseClient: async () => ({ query: sql, release: vi.fn() }),
}));

import { buildJobCards, buildQueueCards, fetchJobPopulationStats, fetchQueuePopulationStats, fetchWorkflowGroupRows } from './dashboard-read-model';

const repos = [{ id: 1, key: 'o/r' }];
const start = '2026-01-01';
const end = '2026-01-07';

beforeEach(() => { sql.mockReset(); });

describe('timing coverage aggregation', () => {
  it('counts workflow evidence once per group attempt and maps independent counts', async () => {
    sql.mockImplementation(async (text: string) => text.includes('WITH tracked AS') ? {
      rows: [{ repo_id: 1, resource_model: 'cpu', machine_hours: '1', unknown_cost_count: '0', attempt_count: '4', success_count: '2', terminal_count: '3', avg_total_duration: '100', total_duration_samples: '2', total_duration_eligible_count: '4', latest_date: start }],
    } : { rows: [] });
    const [group] = await fetchWorkflowGroupRows(repos, start, end);
    expect(group).toMatchObject({ totalDurationSamples: 2, totalDurationEligibleCount: 4 });
    const text = sql.mock.calls.find(([query]) => query.includes('WITH tracked AS'))![0] as string;
    expect(text).toContain('COUNT(total_duration_seconds) AS total_duration_samples');
    expect(text).toContain('COUNT(*) AS total_duration_eligible_count');
    expect(text).toContain('FROM per_group_attempt');
    expect(text).not.toMatch(/LIMIT|OFFSET/);
  });

  it('maps job and queue population counts independently of timing values', async () => {
    sql.mockResolvedValueOnce({ rows: [{ total_jobs: '8', terminal_count: '7', success_count: '5', successful_total_duration_samples: '2', p50_total_duration: '100', p90_total_duration: '200', unknown_resource_samples: '0' }] });
    sql.mockResolvedValueOnce({ rows: [{ sample_count: '3', eligible_count: '8', p50_queue: '10', p90_queue: '20', max_queue: '20', over_one_hour_count: '0', invalid_timing_samples: '5', distinct_resource_models: '1', unknown_resource_samples: '0' }] });
    const job = await fetchJobPopulationStats(repos, start, end);
    const queue = await fetchQueuePopulationStats(repos, start, end);
    expect(buildJobCards(job, [], false)).toMatchObject({ successfulTotalDurationSamples: 2, successfulTotalDurationEligibleCount: 5 });
    expect(buildQueueCards(queue)).toMatchObject({ queueDurationSamples: 3, queueDurationEligibleCount: 8 });
    expect(sql.mock.calls[0][0]).toMatch(/AS successful_total_duration_samples/);
    expect(sql.mock.calls[1][0]).toContain('COUNT(*) AS eligible_count');
    for (const [text] of sql.mock.calls) expect(text).not.toMatch(/LIMIT|OFFSET/);
  });

  it('returns zero counts for an empty repository population', async () => {
    expect(buildJobCards(await fetchJobPopulationStats([], start, end), [], false)).toMatchObject({ successfulTotalDurationSamples: 0, successfulTotalDurationEligibleCount: 0 });
    expect(buildQueueCards(await fetchQueuePopulationStats([], start, end))).toMatchObject({ queueDurationSamples: 0, queueDurationEligibleCount: 0 });
    expect(sql).not.toHaveBeenCalled();
  });
});
