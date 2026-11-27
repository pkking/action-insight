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
import { fetchJobAttemptDrilldown, fetchJobGroupRows, fetchJobPopulationStats, fetchQueueDailyP90, fetchQueueGroupRows, fetchQueuePopulationStats, fetchWorkflowAttemptDrilldown, fetchWorkflowAttemptRows, fetchWorkflowGroupRows, fetchRunsStats, getDashboardReadModel } from './dashboard-read-model';

function expectEvidence(query: string, alias: 'wa' | 'wj', metric: string) {
  const evidence = `(to_jsonb(${alias})->'timing_evidence')`;
  expect(query).toContain(`${evidence}->'version' = '1'::jsonb`);
  expect(query).toContain(`jsonb_typeof(${evidence}->'${metric}') = 'number'`);
  expect(query).toContain(`(${evidence}->>'${metric}')::numeric >= 0`);
  expect(query).toContain(`(${evidence}->>'${metric}')::numeric <= 1.7976931348623157e308::numeric`);
}

describe('Runs SQL pagination', () => {
  it('clamps an out-of-range page before querying and displays the last page', async () => {
    sql.mockReset();
    sql.mockResolvedValueOnce({ rows: [{ total: 41, success: 41, terminal: 41, avg_runtime: 123, successful_runtime_samples: 30 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ run_id: 7, repo_id: 1, run_attempt: 1, event: 'push', status: 'completed', total_count: 41 }] });
    const result = await getDashboardReadModel({ tab: 'runs', repoKey: 'o/r', startDate: '2026-01-01', endDate: '2026-01-07', page: 99, pageSize: 20, observationLimit: 500 });
    expect(sql.mock.calls[3][0]).toMatch(/ORDER BY timing\.window_at DESC, wa\.run_id DESC, wa\.run_attempt DESC/);
    expectEvidence(sql.mock.calls[3][0], 'wa', 'queue_duration_seconds');
    expectEvidence(sql.mock.calls[3][0], 'wa', 'runtime_seconds');
    expect(sql.mock.calls[3][0]).toContain("AT TIME ZONE 'UTC'");
    expect(sql.mock.calls[3][0]).not.toMatch(/r\.date\s*[<>]/);
    expect(sql.mock.calls[3][0]).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(sql.mock.calls[3][0]).not.toMatch(/COUNT\(\*\) OVER/i);
    expect(sql.mock.calls[3][1]).toEqual([1, '2026-01-01', '2026-01-07', 20, 40]);
    expectEvidence(sql.mock.calls[0][0], 'wa', 'runtime_seconds');
    expect(sql.mock.calls[0][0]).toContain('AS avg_runtime');
    expect(sql.mock.calls[0][0]).toContain('AS p50');
    expect(sql.mock.calls[0][0]).toContain('AS p90');
    expect(sql.mock.calls[0][0].match(/FILTER \(WHERE wa\.conclusion = 'success'\)/g)).toHaveLength(5);
    expect(sql.mock.calls[0][0]).not.toContain('wa.runtime_seconds');
    const chartSql = sql.mock.calls.find(([query]) => query.includes('AS plot_time'))?.[0];
    expectEvidence(chartSql, 'wa', 'runtime_seconds');
    expect(sql.mock.calls[0][0]).not.toMatch(/LIMIT|OFFSET/);
    if (result.tab !== 'runs') throw new Error('Expected runs');
    expect(result.cards.totalAttempts).toBe(41);
    expect(result.cards.avgRuntime).toBe(123);
    expect(result.cards.successfulRuntimeSamples).toBe(30);
    expect(result.cards.successfulRuntimeEligibleCount).toBe(41);
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
      if (query.includes('AS avg_runtime')) return { rows: [{ total: 25, success: 12, terminal: 25 }] };
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

  it.skipIf(!process.env.DASHBOARD_TIMING_TEST_DATABASE_URL)('evaluates evidence independently on old and new PostgreSQL schemas', async () => {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: process.env.DASHBOARD_TIMING_TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query('CREATE TEMP TABLE runs (id integer, repo_id integer, date text, created_at text, event text)');
      await client.query('CREATE TEMP TABLE workflow_attempts (run_id integer, run_attempt integer, workflow_file text, workflow_ref text, status text, conclusion text, created_at text, run_started_at text, tracked integer)');
      await client.query("INSERT INTO runs VALUES (1, 1, '2026-01-01', '2026-01-01T00:00:00Z', 'push')");
      await client.query("INSERT INTO workflow_attempts VALUES (1, 1, 'ci.yml', 'main', 'completed', 'success', '2026-01-01T00:00:00Z', NULL, 1)");
      sql.mockReset();
      sql.mockImplementation((text: string, params: unknown[]) => client.query(text, params));
      const fetch = () => fetchWorkflowAttemptRows([{ id: 1, key: 'o/r' }], '2026-01-01', '2026-01-07');
      expect(await fetch()).toEqual([expect.objectContaining({ queueDurationSeconds: null, runtimeSeconds: null, totalDurationSeconds: null })]);
      await client.query('ALTER TABLE workflow_attempts ADD COLUMN timing_evidence jsonb');
      const cases = [
        [{ version: 1, queue_duration_seconds: 0, runtime_seconds: 5358, total_duration_seconds: 144000 }, [0, 5358, 144000]],
        [{ version: 1, queue_duration_seconds: -1, runtime_seconds: '123', total_duration_seconds: 2 }, [null, null, 2]],
        [{ version: 2, queue_duration_seconds: 1, runtime_seconds: 2, total_duration_seconds: 3 }, [null, null, null]],
        [{ version: '1', queue_duration_seconds: 1, runtime_seconds: 2, total_duration_seconds: 3 }, [null, null, null]],
        [{ version: 1, queue_duration_seconds: null }, [null, null, null]],
      ] as const;
      for (const [evidence, expected] of cases) {
        await client.query('UPDATE workflow_attempts SET timing_evidence = $1::jsonb', [JSON.stringify(evidence)]);
        const [row] = await fetch();
        expect([row.queueDurationSeconds, row.runtimeSeconds, row.totalDurationSeconds]).toEqual(expected);
      }
      await client.query(`UPDATE workflow_attempts SET timing_evidence = '{"version":1,"runtime_seconds":1e309}'::jsonb`);
      expect((await fetch())[0].runtimeSeconds).toBeNull();
      await client.query(`UPDATE workflow_attempts SET timing_evidence = '{"version":1,"runtime_seconds":100}'::jsonb`);
      await client.query(`INSERT INTO workflow_attempts VALUES
        (1, 2, 'ci.yml', 'main', 'completed', 'failure', NULL, '2026-01-01T00:00:00Z', 1, '{"version":1,"runtime_seconds":9999}'),
        (1, 3, 'ci.yml', 'main', 'completed', 'success', NULL, '2026-01-01T00:00:00Z', 1, NULL),
        (1, 4, 'ci.yml', 'main', 'completed', 'success', NULL, '2026-01-01T00:00:00Z', 1, '{"version":1,"runtime_seconds":300}')`);
      const stats = await fetchRunsStats([{ id: 1, key: 'o/r' }], '2026-01-01', '2026-01-07');
      expect(stats).toMatchObject({ success: 3, successfulRuntimeSamples: 2, avgRuntimeSeconds: 200, p50RuntimeSeconds: 100, p90RuntimeSeconds: 300 });
    } finally {
      sql.mockReset();
      await client.end();
    }
  });

  it('uses independent guarded evidence in workflow and job duration queries', async () => {
    sql.mockReset();
    sql.mockResolvedValue({ rows: [] });
    const repos = [{ id: 1, key: 'o/r' }];
    await fetchWorkflowAttemptRows(repos, '2026-01-01', '2026-01-07');
    await fetchWorkflowAttemptDrilldown(1, 'o/r', 'ci.yml', null, null);
    await fetchWorkflowGroupRows(repos, '2026-01-01', '2026-01-07');
    await fetchJobAttemptDrilldown(1, 'o/r', 'ci.yml', null, 'test', null);
    await fetchJobGroupRows(repos, '2026-01-01', '2026-01-07');
    await fetchJobPopulationStats(repos, '2026-01-01', '2026-01-07');
    await fetchQueueGroupRows(repos, '2026-01-01', '2026-01-07');
    await fetchQueuePopulationStats(repos, '2026-01-01', '2026-01-07');
    await fetchQueueDailyP90(repos, '2026-01-01', '2026-01-07');
    const queries = sql.mock.calls.map(([query]) => query as string);
    const workflowRows = queries.filter((query) => query.includes('AS queue_duration_seconds') && query.includes('FROM workflow_attempts wa'));
    expect(workflowRows).toHaveLength(2);
    for (const query of workflowRows) {
      for (const metric of ['queue_duration_seconds', 'runtime_seconds', 'total_duration_seconds']) expectEvidence(query, 'wa', metric);
    }
    expectEvidence(queries.find((query) => query.includes('WITH tracked AS'))!, 'wa', 'total_duration_seconds');
    const jobDrilldown = queries.find((query) => query.includes('wj.job_id,') && query.includes('AS queue_duration_seconds'))!;
    for (const metric of ['queue_duration_seconds', 'runtime_seconds', 'total_duration_seconds']) expectEvidence(jobDrilldown, 'wj', metric);
    for (const marker of ['AS avg_total_duration', 'AS p50_total_duration', 'AS queue_p90', 'AS sample_count', 'AS p90\n']) {
      const query = queries.find((text) => text.includes(marker) && text.includes("to_jsonb(wj)->'timing_evidence'"));
      expect(query).toBeDefined();
      expectEvidence(query!, 'wj', marker.includes('total_duration') ? 'total_duration_seconds' : 'queue_duration_seconds');
    }
  });
});
