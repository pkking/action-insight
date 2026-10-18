import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAdaptiveJobsForRunAttempt, InvalidJobsResponseError } from './github-jobs';
import { withRetry } from './collect';

const jobs = (count: number, offset = 0) => Array.from({ length: count }, (_, id) => ({
  id: offset + id, name: `job-${offset + id}`, status: 'completed',
  started_at: '2026-10-10T10:00:00Z', html_url: `https://example.com/jobs/${offset + id}`,
}));
const error = (status: number) => Object.assign(new Error('GitHub request failed'), { status });
type Page = { page: number; per_page: number; attempt_number?: number };
const fetch = (request: ReturnType<typeof vi.fn>, attempt = 1) =>
  fetchAdaptiveJobsForRunAttempt({ request } as never, 'owner', 'repo', 42, attempt, operation => operation());

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('adaptive GitHub jobs pagination', () => {
  it('keeps the normal 100-job page size, including a terminal empty page', async () => {
    const data = jobs(200);
    const request = vi.fn(async (_route: string, p: Page) => ({
      data: { jobs: data.slice((p.page - 1) * p.per_page, p.page * p.per_page) },
    }));
    await expect(fetch(request)).resolves.toEqual({ jobs: data });
    expect(request.mock.calls.map(([, p]) => [p.page, p.per_page])).toEqual([[1, 100], [2, 100], [3, 100]]);
  });

  it('discards the partial pass and restarts at page 1 after a later-page failure', async () => {
    const data = jobs(65);
    const request = vi.fn(async (_route: string, p: Page) => {
      if (p.per_page === 100) {
        if (p.page === 2) throw error(502);
        return { data: { jobs: jobs(100, 1000) } };
      }
      return { data: { jobs: data.slice((p.page - 1) * p.per_page, p.page * p.per_page) } };
    });
    await expect(fetch(request)).resolves.toEqual({ jobs: data });
    expect(request.mock.calls.map(([, p]) => [p.page, p.per_page])).toEqual([
      [1, 100], [2, 100], [1, 30], [2, 30], [3, 30],
    ]);
  });

  it.each([502, 503, 504])('uses the full bounded fallback chain for HTTP %i', async status => {
    const data = jobs(2);
    const request = vi.fn(async (_route: string, p: Page) => {
      if (p.per_page > 1) throw error(status);
      return { data: { jobs: data.slice(p.page - 1, p.page) } };
    });
    await expect(fetch(request, 3)).resolves.toEqual({ jobs: data });
    expect(request.mock.calls.map(([, p]) => p.per_page)).toEqual([100, 30, 10, 1, 1, 1]);
    for (const [route, p] of request.mock.calls) {
      expect(route).toContain('/attempts/{attempt_number}/jobs');
      expect(p.attempt_number).toBe(3);
    }
  });

  it('propagates failure at size 1 without returning partial jobs', async () => {
    const failure = error(502);
    const request = vi.fn().mockRejectedValue(failure);
    await expect(fetch(request)).rejects.toBe(failure);
    expect(request.mock.calls.map(([, p]) => p.per_page)).toEqual([100, 30, 10, 1]);
  });

  it.each([401, 403, 404, 422, 429, 500])('does not shrink pages or substitute latest jobs on HTTP %i', async status => {
    const failure = error(status);
    const request = vi.fn().mockRejectedValue(failure);
    await expect(fetch(request, 2)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('/attempts/{attempt_number}/jobs');
  });

  it.each([{}, null, { jobs: null }, { jobs: 'invalid' }, { jobs: [null] }, { jobs: [{ id: '42' }] }])(
    'rejects malformed jobs responses rather than recording empty results: %j', async data => {
      const request = vi.fn().mockResolvedValue({ data });
      await expect(fetch(request)).rejects.toBeInstanceOf(InvalidJobsResponseError);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts an explicit empty jobs array', async () => {
    await expect(fetch(vi.fn().mockResolvedValue({ data: { jobs: [] } }))).resolves.toEqual({ jobs: [] });
  });

  it('deduplicates IDs across successful pages', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { jobs: jobs(100) } })
      .mockResolvedValueOnce({ data: { jobs: jobs(2, 99) } });
    const result = await fetch(request);
    expect(result.jobs).toHaveLength(101);
    expect(new Set(result.jobs.map(job => job.id)).size).toBe(101);
  });

  it('exhausts the caller retry policy before shrinking a page', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_route: string, p: Page) => {
      if (p.per_page === 100) throw error(502);
      return { data: { jobs: jobs(1) } };
    });
    const pending = fetchAdaptiveJobsForRunAttempt({ request } as never, 'owner', 'repo', 42, 1,
      (operation, context) => withRetry(operation, 3, 2000, undefined, context));
    const assertion = expect(pending).resolves.toMatchObject({ jobs: [{ id: 0 }] });
    await vi.runAllTimersAsync();
    await assertion;
    expect(request.mock.calls.map(([, p]) => p.per_page)).toEqual([100, 100, 100, 100, 30]);
  });

  it('emits only safe fallback metadata', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn().mockRejectedValueOnce(Object.assign(error(502), {
      message: 'token=opaque-secret', request: { headers: { authorization: 'opaque-secret' } },
    })).mockResolvedValue({ data: { jobs: [] } });
    await fetch(request);
    const output = String(warn.mock.calls[0][0]);
    expect(output).toContain('Jobs pagination fallback:');
    expect(output).toContain('"restartPage":1');
    expect(output).not.toContain('opaque-secret');
  });
});
