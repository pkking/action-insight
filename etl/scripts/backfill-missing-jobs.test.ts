import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backfillRepo, buildMissingAttemptsQuery, listEligibleMissingAttempts, parseArgs } from './backfill-missing-jobs';
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
        id: 7, run_id: 42, name: 'npu', status: 'completed', conclusion: 'success',
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
        timing_evidence: { version: 1, queue_duration_seconds: 60, runtime_seconds: 3540,
          total_duration_seconds: 3600, completion_source: 'github_job.completed_at', completed_at: '2026-10-10T11:00:00Z' },
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

  it('leaves legacy completion unverified and preserves verified completion evidence', async () => {
    const verified = { ...row, completed_at: '2026-10-10T10:50:00Z', timing_evidence: {
      version: 1, runtime_seconds: 2940, completion_source: 'github_run.completed_at', completed_at: '2026-10-10T10:50:00Z',
    } };
    vi.mocked(getDatabaseClient).mockResolvedValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [row, verified] }),
      release: vi.fn(),
    } as never);
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);
    await backfillRepo('owner/repo', config, 14, 'test-token');
    const calls = vi.mocked(writeWorkflowAttempts).mock.calls;
    expect(calls[0][1][0].timing_evidence).toBeUndefined();
    expect(calls[0][1][0].completed_at).toBeNull();
    expect(calls[1][1][0].completed_at).toBe(verified.completed_at);
    expect(calls[1][1][0].timing_evidence).toEqual(verified.timing_evidence);
  });

  it.each([true, false])('retains trigger only when it matches stored creation: %s', async matches => {
    const first = { ...row, run_attempt: 1, completed_at: '2026-10-10T10:50:00Z', timing_evidence: {
      version: 1, total_duration_seconds: 3000, completion_source: 'github_run.completed_at',
      completed_at: '2026-10-10T10:50:00Z', trigger_at: matches ? row.created_at : '2026-10-10T09:00:00Z',
    } };
    vi.mocked(getDatabaseClient).mockResolvedValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [first] }), release: vi.fn(),
    } as never);
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);
    await backfillRepo('owner/repo', config, 14, 'test-token');
    expect(vi.mocked(writeWorkflowAttempts).mock.calls[0][1][0].timing_evidence).toEqual(matches ? first.timing_evidence : undefined);
  });

  it.each([
    { completed_at: '2026-10-10T10:51:00Z' },
    { run_started_at: '2026-10-10T10:02:00Z' },
  ])('drops completion evidence when stored endpoints changed: %j', async (changed) => {
    const stale = { ...row, completed_at: '2026-10-10T10:50:00Z', ...changed, timing_evidence: {
      version: 1, runtime_seconds: 2940, completion_source: 'github_run.completed_at', completed_at: '2026-10-10T10:50:00Z',
    } };
    vi.mocked(getDatabaseClient).mockResolvedValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [stale] }), release: vi.fn(),
    } as never);
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);
    await backfillRepo('owner/repo', config, 14, 'test-token');
    expect(vi.mocked(writeWorkflowAttempts).mock.calls[0][1][0].timing_evidence).toBeUndefined();
  });

  it('does not retain old completion evidence without its endpoint binding', async () => {
    const stale = { ...row, completed_at: '2026-10-10T10:50:00Z', timing_evidence: {
      version: 1, runtime_seconds: 2940, completion_source: 'github_run.completed_at',
    } };
    vi.mocked(getDatabaseClient).mockResolvedValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [stale] }), release: vi.fn(),
    } as never);
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);
    await backfillRepo('owner/repo', config, 14, 'test-token');
    expect(vi.mocked(writeWorkflowAttempts).mock.calls[0][1][0].timing_evidence).toBeUndefined();
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

describe('fetch-once mode (ADR-038 constraint 3)', () => {
  it('adds the four fetch-once filters without shifting placeholder offsets', () => {
    const sql = buildMissingAttemptsQuery(['ci.yml'], { fetchOnce: true });

    expect(sql).toContain("AND wa.status = 'completed'");
    expect(sql).toContain("AND wa.conclusion IS DISTINCT FROM 'action_required'");
    expect(sql).toContain("AND wa.conclusion IS DISTINCT FROM 'startup_failure'");
    expect(sql).toContain('AND wa.jobs_fetched_at IS NULL');
    expect(sql).toContain('(wa.tracked = 1 OR r.workflow_file IN ($3))');
    expect(sql).toContain('r.created_at::date >= $2::date');
    expect(sql).toContain('r.repo_id = $1');
    // placeholders stay $1 repo, $2 since, $3+ files — the four filter lines are literals, no new placeholders
    expect(sql.match(/\$/g)).toEqual(['$', '$', '$']);
    expect(sql.indexOf('AND wa.jobs_fetched_at IS NULL')).toBeLessThan(sql.indexOf('r.created_at::date >= $2::date'));
  });

  it('keeps the default query free of fetch-once filters', () => {
    const sql = buildMissingAttemptsQuery(['ci.yml']);

    expect(sql).not.toContain("r.status = 'completed'");
    expect(sql).not.toContain("IS DISTINCT FROM");
    expect(sql).not.toContain('jobs_fetched_at');
  });

  it('marks empty job lists as fetched when fetch-once is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-10T12:34:56Z');
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);

    await backfillRepo('owner/repo', config, 14, 'test-token', { fetchOnce: true });

    expect(writeWorkflowAttempts).toHaveBeenCalledWith('owner/repo', [expect.objectContaining({
      jobs: [],
      jobs_fetched_at: '2026-10-10T12:34:56.000Z',
    })]);
  });

  it('marks empty job lists as fetched when fetch-once is off', async () => {
    vi.mocked(createOctokit).mockReturnValue({ request: vi.fn().mockResolvedValue({ data: { jobs: [] } }) } as never);

    await backfillRepo('owner/repo', config, 14, 'test-token');

    expect(writeWorkflowAttempts).toHaveBeenCalledWith('owner/repo', [expect.objectContaining({
      jobs: [],
      jobs_fetched_at: expect.any(String),
    })]);
  });

  it('limits processed attempts to the given max', async () => {
    vi.mocked(getDatabaseClient).mockResolvedValue({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [row, { ...row, run_id: 43, run_attempt: 3 }] }),
      release: vi.fn(),
    } as never);
    const request = vi.fn().mockResolvedValue({ data: { jobs: [{ id: 7 }] } });
    vi.mocked(createOctokit).mockReturnValue({ request } as never);

    await backfillRepo('owner/repo', config, 14, 'test-token', { max: 1 });

    expect(writeWorkflowAttempts).toHaveBeenCalledTimes(1);
    expect(writeWorkflowAttempts).toHaveBeenCalledWith('owner/repo', [expect.objectContaining({ run_id: 42, run_attempt: 2 })]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('list-only mode', () => {
  it('prints per-repo eligible counts without calling the GitHub API or writing', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [row] });
    vi.mocked(getDatabaseClient).mockResolvedValue({ query, release: vi.fn() } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await listEligibleMissingAttempts(['owner/repo'], config, 14, false);

    expect(log).toHaveBeenCalledWith('owner/repo: 1 eligible missing attempts');
    expect(createOctokit).not.toHaveBeenCalled();
    expect(writeWorkflowAttempts).not.toHaveBeenCalled();
  });

  it('composes with fetch-once so the counted query carries the eligibility filters', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValue({ rows: [] });
    vi.mocked(getDatabaseClient).mockResolvedValue({ query, release: vi.fn() } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await listEligibleMissingAttempts(['owner/repo'], config, 14, true);

    expect(log).toHaveBeenCalledWith('owner/repo: 0 eligible missing attempts');
    expect(query.mock.calls[1][0]).toContain('AND wa.jobs_fetched_at IS NULL');
    expect(query.mock.calls[1][0]).toContain("AND wa.status = 'completed'");
  });
});

describe('parseArgs CLI surface', () => {
  it('keeps stock defaults and parses the new modes', () => {
    expect(parseArgs([])).toEqual({ repos: [], days: 14, help: false, listOnly: false, fetchOnce: false });
    expect(parseArgs(['--list-only'])).toMatchObject({ listOnly: true });
    expect(parseArgs(['--fetch-once', '--max', '3'])).toMatchObject({ fetchOnce: true, max: 3 });
    expect(parseArgs(['--max', '5'])).toMatchObject({ max: 5 });
  });

  it.each([
    ['--max'],
    ['--max', '0'],
    ['--max', '-1'],
    ['--max', 'abc'],
    ['--max', '2.5'],
  ])('rejects invalid --max invocation %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow(/--max/);
  });

  it('still rejects unknown options', () => {
    expect(() => parseArgs(['--wat'])).toThrow('Unknown option: --wat');
  });
});
