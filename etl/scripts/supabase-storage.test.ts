import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function mockSupabaseClient(options: {
  cacheRows?: Array<{ head_sha: string; pr_number: number; source: string }>;
  rpcRows?: Array<{ run_id: number | string }>;
  rpcPages?: Array<Array<{ run_id: number | string }>>;
  rpcError?: { message: string } | null;
  runUpsertError?: { message: string } | null;
  jobUpsertError?: { message: string } | null;
}) {
  const upsertedCacheRows: unknown[] = [];
  const upsertedRunRows: unknown[] = [];
  const upsertedJobRows: unknown[] = [];
  const runUpsertBatches: unknown[][] = [];
  const jobUpsertBatches: unknown[][] = [];
  const fromCalls: string[] = [];
  const rpcRange = vi.fn((from: number, to: number) => {
    const pageIndex = Math.floor(from / (to - from + 1));
    const rows = options.rpcPages?.[pageIndex] ?? options.rpcRows ?? [];

    return Promise.resolve({
      data: rows,
      error: options.rpcError ?? null,
    });
  });

  const repoSelectBuilder = {
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: { id: 7 }, error: null }),
      })),
    })),
  };

  const cacheSelectBuilder = {
    eq: vi.fn(() => ({
      in: vi.fn().mockResolvedValue({ data: options.cacheRows ?? [], error: null }),
    })),
  };

  const runsSelectBuilder = {
    eq: vi.fn(() => ({
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  };

  const supabase = {
    rpc: vi.fn(() => ({
      range: rpcRange,
    })),
    from: vi.fn((table: string) => {
      fromCalls.push(table);

      if (table === 'repos') {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn(() => repoSelectBuilder),
        };
      }

      if (table === 'pr_resolution_cache') {
        return {
          select: vi.fn(() => cacheSelectBuilder),
          upsert: vi.fn((rows: unknown[]) => {
            upsertedCacheRows.push(...rows);
            return Promise.resolve({ error: null });
          }),
        };
      }

      if (table === 'runs') {
        return {
          upsert: vi.fn((rows: unknown[]) => {
            runUpsertBatches.push(rows);
            upsertedRunRows.push(...rows);
            return Promise.resolve({ error: options.runUpsertError ?? null });
          }),
          select: vi.fn(() => runsSelectBuilder),
        };
      }

      if (table === 'jobs') {
        return {
          upsert: vi.fn((rows: unknown[]) => {
            jobUpsertBatches.push(rows);
            upsertedJobRows.push(...rows);
            return Promise.resolve({ error: options.jobUpsertError ?? null });
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return {
    supabase,
    upsertedCacheRows,
    upsertedRunRows,
    upsertedJobRows,
    runUpsertBatches,
    jobUpsertBatches,
    fromCalls,
    rpcRange,
  };
}

async function importStorageWithSupabase(supabase: unknown) {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn(() => supabase),
  }));

  return import('./supabase-storage');
}

describe('supabase-storage', () => {
  it('persists raw GitHub API payloads for runs and jobs', async () => {
    const { supabase, upsertedRunRows, upsertedJobRows } = mockSupabaseClient({});
    const { writeRunsToSupabase } = await importStorageWithSupabase(supabase);

    await writeRunsToSupabase('acme/widgets', [
      {
        id: 101,
        name: 'CI',
        head_branch: 'main',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:10:00Z',
        html_url: 'https://example.com/runs/101',
        durationInSeconds: 600,
        githubPayload: {
          id: 101,
          path: '.github/workflows/ci.yml',
          run_attempt: 2,
        },
        jobs: [
          {
            id: 201,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-05-01T00:01:00Z',
            started_at: '2026-05-01T00:02:00Z',
            completed_at: '2026-05-01T00:09:00Z',
            html_url: 'https://example.com/jobs/201',
            queueDurationInSeconds: 60,
            durationInSeconds: 420,
            githubPayload: {
              id: 201,
              runner_name: 'runner-1',
              labels: ['self-hosted', 'npu'],
            },
          },
        ],
      },
    ], '2026-05-01');

    expect(upsertedRunRows).toEqual([
      expect.objectContaining({
        id: 101,
        github_payload: expect.objectContaining({
          path: '.github/workflows/ci.yml',
          run_attempt: 2,
        }),
      }),
    ]);
    expect(upsertedJobRows).toEqual([
      expect.objectContaining({
        id: 201,
        github_payload: expect.objectContaining({
          runner_name: 'runner-1',
          labels: ['self-hosted', 'npu'],
        }),
      }),
    ]);
  });

  it('throws when run upsert fails so collection state is not advanced', async () => {
    const { supabase } = mockSupabaseClient({
      runUpsertError: {
        message: "Could not find the 'github_payload' column of 'runs' in the schema cache",
      },
    });
    const { writeRunsToSupabase } = await importStorageWithSupabase(supabase);

    await expect(
      writeRunsToSupabase('acme/widgets', [
        {
          id: 101,
          name: 'CI',
          head_branch: 'main',
          status: 'completed',
          conclusion: 'success',
          event: 'push',
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:10:00Z',
          html_url: 'https://example.com/runs/101',
          durationInSeconds: 600,
          jobs: [],
        },
      ], '2026-05-01')
    ).rejects.toThrow(
      "Failed to insert runs for acme/widgets into Supabase: Could not find the 'github_payload' column of 'runs' in the schema cache"
    );
  });

  it('chunks run and job upserts to avoid oversized Supabase statements', async () => {
    const { supabase, runUpsertBatches, jobUpsertBatches } = mockSupabaseClient({});
    const { writeRunsToSupabase } = await importStorageWithSupabase(supabase);
    const runs = Array.from({ length: 201 }, (_, index) => ({
      id: 10_000 + index,
      name: 'CI',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:10:00Z',
      html_url: `https://example.com/runs/${10_000 + index}`,
      durationInSeconds: 600,
      jobs: Array.from({ length: 3 }, (_, jobIndex) => ({
        id: 20_000 + index * 3 + jobIndex,
        name: `job-${jobIndex}`,
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-05-01T00:01:00Z',
        started_at: '2026-05-01T00:02:00Z',
        completed_at: '2026-05-01T00:09:00Z',
        html_url: `https://example.com/jobs/${20_000 + index * 3 + jobIndex}`,
        queueDurationInSeconds: 60,
        durationInSeconds: 420,
      })),
    }));

    await writeRunsToSupabase('acme/widgets', runs, '2026-05-01');

    expect(runUpsertBatches.map((batch) => batch.length)).toEqual([200, 1]);
    expect(jobUpsertBatches.map((batch) => batch.length)).toEqual([500, 103]);
  });

  it('allows Supabase upsert batch sizes to be tuned with environment variables', async () => {
    vi.stubEnv('RUN_UPSERT_BATCH_SIZE', '50');
    vi.stubEnv('JOB_UPSERT_BATCH_SIZE', '75');

    const { supabase, runUpsertBatches, jobUpsertBatches } = mockSupabaseClient({});
    const { writeRunsToSupabase } = await importStorageWithSupabase(supabase);
    const runs = Array.from({ length: 51 }, (_, index) => ({
      id: 10_000 + index,
      name: 'CI',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:10:00Z',
      html_url: `https://example.com/runs/${10_000 + index}`,
      durationInSeconds: 600,
      jobs: Array.from({ length: 2 }, (_, jobIndex) => ({
        id: 20_000 + index * 2 + jobIndex,
        name: `job-${jobIndex}`,
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-05-01T00:01:00Z',
        started_at: '2026-05-01T00:02:00Z',
        completed_at: '2026-05-01T00:09:00Z',
        html_url: `https://example.com/jobs/${20_000 + index * 2 + jobIndex}`,
        queueDurationInSeconds: 60,
        durationInSeconds: 420,
      })),
    }));

    await writeRunsToSupabase('acme/widgets', runs, '2026-05-01');

    expect(runUpsertBatches.map((batch) => batch.length)).toEqual([50, 1]);
    expect(jobUpsertBatches.map((batch) => batch.length)).toEqual([75, 27]);
  });

  it('uses the server-side RPC to read run IDs with jobs', async () => {
    const { supabase, fromCalls, rpcRange } = mockSupabaseClient({
      rpcRows: [{ run_id: '101' }, { run_id: 102 }],
    });
    const { getExistingRunIdsWithJobsFromSupabase } = await importStorageWithSupabase(supabase);

    const runIds = await getExistingRunIdsWithJobsFromSupabase('acme/widgets');

    expect(runIds).toEqual(new Set([101, 102]));
    expect(supabase.rpc).toHaveBeenCalledWith('get_run_ids_with_jobs', { p_repo_id: 7 });
    expect(rpcRange).toHaveBeenCalledWith(0, 999);
    expect(fromCalls).not.toContain('runs');
  });

  it('paginates the server-side RPC when reading run IDs with jobs', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({ run_id: i + 1 }));
    const { supabase, rpcRange } = mockSupabaseClient({
      rpcPages: [firstPage, [{ run_id: '1001' }]],
    });
    const { getExistingRunIdsWithJobsFromSupabase } = await importStorageWithSupabase(supabase);

    const runIds = await getExistingRunIdsWithJobsFromSupabase('acme/widgets');

    expect(runIds.size).toBe(1001);
    expect(runIds.has(1)).toBe(true);
    expect(runIds.has(1001)).toBe(true);
    expect(rpcRange).toHaveBeenCalledWith(0, 999);
    expect(rpcRange).toHaveBeenCalledWith(1000, 1999);
  });

  it('does not overwrite higher-confidence PR resolution cache entries with run payload refs', async () => {
    const { supabase, upsertedCacheRows } = mockSupabaseClient({
      cacheRows: [
        {
          head_sha: 'sha-existing',
          pr_number: 42,
          source: 'commits_api',
        },
      ],
    });
    const { writePullRequestResolutionCacheToSupabase } = await importStorageWithSupabase(supabase);

    await writePullRequestResolutionCacheToSupabase('acme/widgets', [
      {
        head_sha: 'sha-existing',
        pr_number: 99,
        source: 'run_payload',
      },
      {
        head_sha: 'sha-new',
        pr_number: 100,
        source: 'run_payload',
      },
    ]);

    expect(upsertedCacheRows).toEqual([
      expect.objectContaining({
        head_sha: 'sha-new',
        pr_number: 100,
        source: 'run_payload',
      }),
    ]);
  });

  it('allows higher-confidence commits API resolutions to replace search fallback entries', async () => {
    const { supabase, upsertedCacheRows } = mockSupabaseClient({
      cacheRows: [
        {
          head_sha: 'sha-existing',
          pr_number: 42,
          source: 'search_api',
        },
      ],
    });
    const { writePullRequestResolutionCacheToSupabase } = await importStorageWithSupabase(supabase);

    await writePullRequestResolutionCacheToSupabase('acme/widgets', [
      {
        head_sha: 'sha-existing',
        pr_number: 43,
        source: 'commits_api',
      },
    ]);

    expect(upsertedCacheRows).toEqual([
      expect.objectContaining({
        head_sha: 'sha-existing',
        pr_number: 43,
        source: 'commits_api',
      }),
    ]);
  });
});
