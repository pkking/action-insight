import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backfillRepo, buildMissingAttemptsQuery } from './backfill-missing-jobs';
import { getDatabaseClient } from '../../src/lib/db';
import { writeWorkflowAttempts } from './pg-storage';
import { createOctokit } from './github';

vi.mock('../../src/lib/db.ts', () => ({ getDatabaseClient: vi.fn() }));
vi.mock('./pg-storage.ts', () => ({ writeWorkflowAttempts: vi.fn() }));
vi.mock('./github', () => ({ createOctokit: vi.fn(), resolveGitHubTokens: vi.fn() }));

const row = {
  run_id: 42, run_attempt: 2, name: 'CI', head_branch: 'main', head_sha: 'sha',
  status: 'completed', conclusion: 'success', event: 'pull_request',
  created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T11:00:00Z',
  run_started_at: '2026-10-10T10:01:00Z', html_url: 'https://example.com/runs/42',
  workflow_path: '.github/workflows/ci.yml', workflow_parse_status: 'parsed', duration_seconds: 3600,
};
const config = { repos: [{ repo: 'owner/repo', workflows: [{ file: 'ci.yml' }] }] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDatabaseClient).mockResolvedValue({
    query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [row] }),
    release: vi.fn(),
  } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backfill persistence boundary', () => {
  it('uses smaller pages and preserves timestamps, resources and steps through the existing writer', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_route: string, params: { per_page: number }) => {
      if (params.per_page === 100) throw Object.assign(new Error('gateway failure'), { status: 502 });
      return { data: { jobs: [{
        id: 7, name: 'npu', status: 'completed', conclusion: 'success',
        created_at: '2026-10-10T10:00:00Z', started_at: '2026-10-10T10:01:00Z',
        completed_at: '2026-10-10T11:00:00Z', labels: ['linux-aarch64-a2-8'], runner_id: 99,
        steps: [{ number: 1, name: 'test', status: 'completed', conclusion: 'success',
          started_at: '2026-10-10T10:02:00Z', completed_at: '2026-10-10T11:00:00Z' }],
      }] } };
    });
    vi.mocked(createOctokit).mockReturnValue({ request } as never);
    const pending = backfillRepo('owner/repo', config, 14, 'test-token');
    await vi.runAllTimersAsync();
    await pending;
    expect(request.mock.calls.map(([, params]) => params.per_page)).toEqual([100, 100, 100, 100, 30]);
    expect(writeWorkflowAttempts).toHaveBeenCalledWith('owner/repo', [expect.objectContaining({
      run_id: 42, run_attempt: 2, jobs: [expect.objectContaining({
        job_id: 7, queue_duration_seconds: 60, runtime_seconds: 3540,
        resource_model: 'linux-aarch64-a2', resource_count: 8, runner_id: 99,
        steps: [expect.objectContaining({ name: 'test' })],
      })],
    })]);
  });

  it.each([404, 422, 403, 429, 502])('does not write empty or partial attempts after HTTP %i', async status => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), { status }));
    vi.mocked(createOctokit).mockReturnValue({ request } as never);
    const assertion = expect(backfillRepo('owner/repo', config, 14, 'test-token')).rejects.toMatchObject({ status });
    await vi.runAllTimersAsync();
    await assertion;
    expect(writeWorkflowAttempts).not.toHaveBeenCalled();
  });

  it('does not persist a partial first page when a later page is inaccessible', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { jobs: Array.from({ length: 100 }, (_, id) => ({ id })) } })
      .mockRejectedValue(Object.assign(new Error('historical page unavailable'), { status: 404 }));
    vi.mocked(createOctokit).mockReturnValue({ request } as never);
    await expect(backfillRepo('owner/repo', config, 14, 'test-token')).rejects.toMatchObject({ status: 404 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(writeWorkflowAttempts).not.toHaveBeenCalled();
  });

  it('allows a verified empty result through the writer', async () => {
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);
    await backfillRepo('owner/repo', config, 14, 'test-token');
    expect(writeWorkflowAttempts).toHaveBeenCalledWith('owner/repo', [expect.objectContaining({ jobs: [] })]);
  });
});

describe('buildMissingAttemptsQuery', () => {
  it('includes newly configured workflow files even when stored attempts are not tracked yet', () => {
    const sql = buildMissingAttemptsQuery(['nightly-npu.yml', 'nightly-nvidia.yml']);

    expect(sql).toContain('(wa.tracked = 1 OR r.workflow_file IN ($3,$4))');
  });

  it('uses only tracked attempts when no workflow files are configured', () => {
    const sql = buildMissingAttemptsQuery([]);

    expect(sql).toContain('(wa.tracked = 1)');
  });
});
