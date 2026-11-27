import { describe, expect, it, vi } from 'vitest';

describe('pr-data-fetcher', () => {
  it.each<[string, unknown, number | undefined, number | undefined, number | undefined, string?]>([
    ['missing', undefined, undefined, undefined, undefined],
    ['unknown version', { version: 2, total_duration_seconds: 12 }, undefined, undefined, undefined],
    ['invalid values', { version: 1, total_duration_seconds: '12', runtime_seconds: -1, queue_duration_seconds: null }, undefined, undefined, undefined],
    ['valid partial evidence', { version: 1, total_duration_seconds: 90, queue_duration_seconds: 0, completion_source: 'jobs' }, 90, 0, undefined],
    ['valid full evidence', { version: 1, total_duration_seconds: 90, queue_duration_seconds: 10, runtime_seconds: 80 }, 90, 10, 80],
    ['attempt completion', { version: 1 }, undefined, undefined, undefined, '2024-01-03T01:00:00Z'],
  ])('bounds attempt timing to %s evidence', async (_label, evidence, total, queue, runtime, completion) => {
    vi.resetModules();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM pr_metrics')) return { rows: [{ id: 1, pr_number: 42, created_at: '2024-01-01T00:00:00Z' }] };
      if (sql.includes('FROM pr_workflow_attempts')) return { rows: [{ run_id: 10, run_attempt: 2 }] };
      if (sql.includes('FROM workflow_attempts wa')) return { rows: [{
        id: 10, run_attempt: 2, status: 'completed', conclusion: 'success',
        created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-04T00:00:00Z',
        attempt_created_at: '2024-01-03T00:00:00Z', attempt_updated_at: null, completed_at: completion ?? null,
        duration_seconds: 999, total_duration_seconds: 888, runtime_seconds: 777, queue_duration_seconds: 666,
        timing_evidence: evidence,
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    vi.doMock('./db', () => ({ getRepoId: vi.fn().mockResolvedValue(1), getDatabaseClient: vi.fn().mockResolvedValue({ query, release }) }));
    try {
      const { fetchPullRequestDetail } = await import('./pr-data-fetcher');
      const result = await fetchPullRequestDetail('foo', 'bar', 42);
      const attempt = result.pr.workflows[0];
      expect(attempt.durationInSeconds).toBe(total);
      expect(attempt.queueDurationInSeconds).toBe(queue);
      expect(attempt.runtimeInSeconds).toBe(runtime);
      expect(attempt.updated_at).toBe(completion ?? '');
      expect(attempt.parentCreatedAt).toBe('2024-01-02T00:00:00Z');
      expect(attempt.parentUpdatedAt).toBe('2024-01-04T00:00:00Z');
      expect(query.mock.calls.find(([sql]) => sql.includes('LEFT JOIN workflow_jobs'))?.[0]).toContain("to_jsonb(wa)->'timing_evidence'");
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('./db');
      vi.resetModules();
    }
  });

  it.each([
    { label: 'verified first trigger', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, trigger_at: '2024-01-02T00:00:00Z', total_duration_seconds: 60, completion_source: 'github_run.completed_at', completed_at: '2024-01-02T00:01:00Z' }, completion: '2024-01-02T00:01:00Z', end: '2024-01-02T00:01:00Z', trigger: '2024-01-02T00:00:00Z', wall: 60 },
    { label: 'mismatched trigger', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, trigger_at: '2024-01-02T00:02:00Z' } },
    { label: 'rerun trigger forbidden', attempt: 2, created: '2024-01-02T00:00:00Z', evidence: { version: 1, trigger_at: '2024-01-02T00:00:00Z', runtime_seconds: 5358 }, runtime: 5358 },
    { label: 'first attempt creation is not bound by evidence', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, total_duration_seconds: 60, runtime_seconds: 40, completion_source: 'github_run.completed_at', completed_at: '2024-01-02T00:01:00Z' }, completion: '2024-01-02T00:01:00Z', end: '2024-01-02T00:01:00Z', runtime: 40 },
    { label: 'queue alone does not bind creation', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, queue_duration_seconds: 0 } },
    { label: 'no attempt creation', attempt: 1, evidence: { version: 1, total_duration_seconds: 60 } },
    { label: 'rerun keeps independent runtime', attempt: 2, created: '2024-01-03T00:00:00Z', evidence: { version: 1, total_duration_seconds: 60, runtime_seconds: 40 }, runtime: 40 },
    { label: 'marker does not verify legacy completion', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, total_duration_seconds: 60, completion_source: 'github_run.completed_at' }, completion: '2024-01-02T00:01:00Z' },
    { label: 'mismatched endpoint', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 1, total_duration_seconds: 60, completion_source: 'github_run.completed_at', completed_at: '2024-01-02T00:01:00Z' }, completion: '2024-01-02T00:02:00Z' },
    { label: 'unknown version', attempt: 1, created: '2024-01-02T00:00:00Z', evidence: { version: 2, total_duration_seconds: 60, runtime_seconds: 40 } },
  ])('maps cycle timing: $label', async ({ attempt, created, evidence, completion, end, runtime, trigger, wall }) => {
    vi.resetModules();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM pr_metrics')) return { rows: [{ id: 1, pr_number: 42, created_at: '2024-01-01T00:00:00Z' }] };
      if (sql.includes('FROM pr_workflow_attempts')) return { rows: [{ run_id: 10, run_attempt: attempt }] };
      if (sql.includes('FROM workflow_attempts wa')) return { rows: [{
        id: 10, run_attempt: attempt, head_sha: 'abc', status: 'completed', conclusion: 'success',
        created_at: '2024-01-02T00:00:00Z', attempt_created_at: created,
        completed_at: completion, timing_evidence: evidence,
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.doMock('./db', () => ({ getRepoId: vi.fn().mockResolvedValue(1), getDatabaseClient: vi.fn().mockResolvedValue({ query, release: vi.fn() }) }));
    try {
      const { fetchPullRequestDetail } = await import('./pr-data-fetcher');
      const { groupRunsIntoCycles } = await import('./ci-cycles');
      const run = (await fetchPullRequestDetail('foo', 'bar', 42)).pr.workflows[0];
      expect(run.created_at).toBe('2024-01-02T00:00:00Z');
      expect(run.attemptTiming).toEqual({ triggerAt: trigger, completedAt: end, runtimeSeconds: runtime });
      const cycles = groupRunsIntoCycles([run, { ...run, runAttempt: 2, conclusion: 'failure', updated_at: '2024-01-03T16:00:00Z', attemptTiming: { runtimeSeconds: 5358 } }]);
      expect(cycles).toHaveLength(1);
      expect(cycles[0].runs).toHaveLength(2);
      expect(cycles[0].runs[0].wallSeconds).toBe(wall);
      expect(cycles[0].runs[1]).toMatchObject({ startedAt: undefined, endedAt: undefined, wallSeconds: undefined, conclusion: 'failure', runtimeSeconds: 5358 });
    } finally {
      vi.doUnmock('./db');
      vi.resetModules();
    }
  });

  it.each([
    { label: 'legacy only', evidence: undefined, queue: undefined, duration: undefined, total: undefined },
    { label: 'unknown version', evidence: { version: 2, runtime_seconds: 11 }, queue: undefined, duration: undefined, total: undefined },
    { label: 'invalid values', evidence: { version: 1, queue_duration_seconds: -1, runtime_seconds: '11', total_duration_seconds: null }, queue: undefined, duration: undefined, total: undefined },
    { label: 'valid evidence including zero', evidence: { version: 1, queue_duration_seconds: 0, runtime_seconds: 11, total_duration_seconds: 12 }, queue: 0, duration: 11, total: 12 },
  ])('maps raw attempt job timing from $label', async ({ evidence, queue, duration, total }) => {
    vi.resetModules();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM pr_metrics')) return { rows: [{ id: 1, pr_number: 42, created_at: '2024-01-01T00:00:00Z' }] };
      if (sql.includes('FROM pr_workflow_attempts')) return { rows: [{ run_id: 10, run_attempt: 1 }] };
      if (sql.includes('FROM workflow_attempts wa')) return { rows: [{
        id: 10, run_attempt: 1, created_at: '2024-01-02T00:00:00Z',
        attempt_created_at: '2024-01-02T00:00:00Z', timing_evidence: { version: 1, total_duration_seconds: 60 },
        job_id: 20, job_name: 'build', job_status: 'completed',
        job_queue_duration_seconds: 666, job_runtime_seconds: 3600, job_total_duration_seconds: 4266,
        job_resource_model: 'gpu', job_resource_count: 2, job_timing_evidence: evidence,
      }] };
      if (sql.includes('FROM workflow_steps')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.doMock('./db', () => ({ getRepoId: vi.fn().mockResolvedValue(1), getDatabaseClient: vi.fn().mockResolvedValue({ query, release: vi.fn() }) }));
    try {
      const { fetchPullRequestDetail } = await import('./pr-data-fetcher');
      const { computeCardHoursSummary } = await import('./ci-cycles');
      const run = (await fetchPullRequestDetail('foo', 'bar', 42)).pr.workflows[0];
      const job = run.jobs![0];
      expect(run.attemptTiming?.triggerAt).toBeUndefined();
      expect(job.queueDurationInSeconds).toBe(queue);
      expect(job.durationInSeconds).toBe(duration);
      expect(job.totalDurationInSeconds).toBe(total);
      expect(job.runtimeInSeconds).toBe(3600);
      expect(computeCardHoursSummary([{ resourceModel: job.resource_model, resourceCount: job.resource_count, runtimeSeconds: job.runtimeInSeconds }]).totalCardHours).toBe(2);
      expect(query.mock.calls.find(([sql]) => sql.includes('LEFT JOIN workflow_jobs'))?.[0]).toContain("to_jsonb(wj)->'timing_evidence'");
    } finally {
      vi.doUnmock('./db');
      vi.resetModules();
    }
  });

  it('connects to default local PG when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestIndex } = await import('./pr-data-fetcher');

    // Without PG_DATABASE_URL, it falls back to localhost:5433 which is
    // unreachable in the test environment — expect a connection error,
    // NOT a "not configured" error.
    await expect(fetchPullRequestIndex('foo', 'bar')).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });

  it('connects to default local PG for detail fetch when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestDetail } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestDetail('foo', 'bar', 42)).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });
});
