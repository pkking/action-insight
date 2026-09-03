import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectRepo,
  fetchJobsForRunAttempt,
  getSharedRetryCount,
  isTransientError,
  jitteredRetryDelayMs,
  parseRunnerResourceLabels,
  rateLimitCooldown,
  resetSharedRetryCount,
  resolveCollectionHeartbeatMs,
  resolveCollectionSlowOperationMs,
  reserveRateLimitBudget,
  RateLimitAbortError,
  runCollection,
  runSharedCollectionPlan,
  withRetry,
  RETRYABLE_POSTGRES_CODES,
} from './collect';
import * as github from './github';
import { isGitHubRateLimitError } from './github';
import { checkEtlFreshness } from './pg-storage';

vi.mock('./pg-storage.ts', async () => {
  const actual = await vi.importActual<typeof import('./pg-storage')>('./pg-storage');
  return {
    ...actual,
    checkEtlFreshness: vi.fn().mockResolvedValue(null),
    readCollectionState: vi.fn().mockResolvedValue(null),
    writeCollectionState: vi.fn().mockResolvedValue(undefined),
    persistCollectionWindow: vi.fn().mockResolvedValue(undefined),
    getCollectedDates: vi.fn().mockResolvedValue([]),
    getExistingRunIds: vi.fn().mockResolvedValue(new Set()),
    getCachedWorkflowAttempts: vi.fn().mockResolvedValue(new Map()),
    readRunListValidator: vi.fn().mockResolvedValue(null),
    writeRunListValidator: vi.fn().mockResolvedValue(undefined),
    writeRuns: vi.fn().mockResolvedValue(undefined),
    writeWorkflowAttempts: vi.fn().mockResolvedValue(undefined),
  };
});


import {
  readCollectionState,
  writeCollectionState,
  persistCollectionWindow,
  getCollectedDates,
  getExistingRunIds,
  getCachedWorkflowAttempts,
  readRunListValidator,
  writeRunListValidator,
  writeRuns,
  writeWorkflowAttempts,
} from './pg-storage';

function mockRepoState(options: {
  latest?: string;
  dates?: string[];
  historyComplete?: boolean;
  backfillCursor?: string | null;
  retentionDays?: number;
}) {
  vi.mocked(readCollectionState).mockResolvedValue({
    backfillCursor: options.backfillCursor ?? null,
    historyComplete: options.historyComplete ?? true,
    latestDate: options.latest ?? null,
    retentionDays: options.retentionDays ?? 90,
    lastUpdated: null,
  });
  vi.mocked(getCollectedDates).mockResolvedValue(options.dates ?? []);
}


describe('fetchJobsForRunAttempt', () => {
  it('retrieves every job page', async () => {
    const jobs = Array.from({ length: 101 }, (_, id) => ({ id, name: `job-${id}`, status: 'completed', started_at: '2026-04-14T10:00:00Z', html_url: `https://example.com/jobs/${id}` }));
    const request = vi.fn((_route: string, params: { page: number; per_page: number }) => Promise.resolve({
      data: { jobs: params.page === 1 ? jobs.slice(0, 100) : jobs.slice(100) },
    }));

    await expect(fetchJobsForRunAttempt({ request } as never, 'acme', 'widgets', 42, 1)).resolves.toMatchObject({ jobs });
    expect(request).toHaveBeenNthCalledWith(1, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', expect.objectContaining({ page: 1, per_page: 100 }));
    expect(request).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', expect.objectContaining({ page: 2, per_page: 100 }));
  });
});

describe('resolveCollectionHeartbeatMs', () => {
  it('defaults to 30 seconds', () => {
    expect(resolveCollectionHeartbeatMs(undefined)).toBe(30_000);
    expect(resolveCollectionHeartbeatMs('')).toBe(0);
  });

  it('rejects values that would overflow Node timers', () => {
    expect(resolveCollectionHeartbeatMs('2147483')).toBe(2_147_483_000);
    expect(resolveCollectionHeartbeatMs('2147484')).toBe(0);
    expect(resolveCollectionHeartbeatMs('999999999999')).toBe(0);
  });
});

describe('resolveCollectionSlowOperationMs', () => {
  it('defaults to 30 seconds', () => {
    expect(resolveCollectionSlowOperationMs(undefined)).toBe(30_000);
    expect(resolveCollectionSlowOperationMs('')).toBe(0);
  });

  it('rejects values that would overflow Node timers', () => {
    expect(resolveCollectionSlowOperationMs('2147483')).toBe(2_147_483_000);
    expect(resolveCollectionSlowOperationMs('2147484')).toBe(0);
    expect(resolveCollectionSlowOperationMs('999999999999')).toBe(0);
  });
});

describe('isTransientError', () => {
  it('classifies network error codes as transient', () => {
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransientError({ code: 'ERR_SOCKET_TIMEOUT' })).toBe(true);
  });

  it('classifies HTTP 5xx responses as transient', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 502 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 504 })).toBe(true);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });

  it('classifies retryable PostgreSQL error codes as transient', () => {
    for (const code of RETRYABLE_POSTGRES_CODES) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  it('rejects non-retryable PostgreSQL error codes and other values', () => {
    expect(isTransientError({ code: '23505' })).toBe(false); // unique_violation
    expect(isTransientError({ code: '42601' })).toBe(false); // syntax_error
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError('error string')).toBe(false);
    expect(isTransientError({})).toBe(false);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    resetSharedRetryCount();
  });

  it('retries on retryable PostgreSQL errors and increments shared retry count', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('serialization failure') as Error & { code: string };
        err.code = '40001';
        throw err;
      }
      return 'success';
    });

    const result = await withRetry(fn, 3, 1);
    expect(result).toBe('success');
    expect(attempts).toBe(3);
    expect(getSharedRetryCount()).toBe(2);
  });

  it('throws immediately on non-transient errors without retry', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('syntax error') as Error & { code: string };
      err.code = '42601';
      throw err;
    });

    await expect(withRetry(fn, 3, 1)).rejects.toThrow('syntax error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getSharedRetryCount()).toBe(0);
  });
});

describe('reserveRateLimitBudget', () => {
  it('tracks initial reset timestamp and header updates when throwing RateLimitAbortError', async () => {
    const octokit = {
      request: vi.fn(async () => ({
        headers: {
          'x-ratelimit-remaining': '9',
          'x-ratelimit-reset': '1712345678',
        },
      })),
    };
    const wrapped = reserveRateLimitBudget(octokit as never, 11, 1700000000);

    // First request drops remaining to 9 (below reserve 10) and captures new reset header
    await wrapped.request('GET /test');

    // Next request hits budget reserve and carries the updated reset timestamp
    await expect(wrapped.request('GET /test')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RateLimitAbortError);
      const rle = err as RateLimitAbortError;
      expect(rle.details.remaining).toBe('9');
      expect(rle.details.reset).toBe('1712345678');
      return true;
    });
  });
});

describe('jitteredRetryDelayMs', () => {
  it('bounds exponential retry delays with jitter', () => {
    expect(jitteredRetryDelayMs(2_000, () => 0)).toBe(1_000);
    expect(jitteredRetryDelayMs(2_000, () => 0.5)).toBe(2_000);
    expect(jitteredRetryDelayMs(2_000, () => 1)).toBe(3_000);
  });
});

describe('rateLimitCooldown', () => {
  it('reports Retry-After before a primary-rate reset', () => {
    expect(rateLimitCooldown({ retryAfter: '60', reset: '0' })).toBe('60s');
    expect(rateLimitCooldown({ reset: '1712345678' })).toBe('until=2024-04-05T19:34:38.000Z');
    expect(rateLimitCooldown({})).toBe('until=next-cycle');
  });
});

describe('parseRunnerResourceLabels', () => {
  it('parses the configured NPU runner-label convention', () => {
    expect(parseRunnerResourceLabels(['self-hosted', 'linux-aarch64-ascend910b-8'])).toEqual({
      resource_model: 'linux-aarch64-ascend910b',
      resource_count: 8,
    });
  });

  it('leaves unsupported labels unknown', () => {
    expect(parseRunnerResourceLabels(['ubuntu-latest'])).toEqual({});
  });
});

describe('collect rate limit handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.ENABLE_SQLITE_FALLBACK;
    vi.mocked(readCollectionState).mockResolvedValue(null);
    vi.mocked(getCollectedDates).mockResolvedValue([]);
    vi.mocked(getExistingRunIds).mockResolvedValue(new Set());
    vi.mocked(getCachedWorkflowAttempts).mockResolvedValue(new Map());
    vi.mocked(readRunListValidator).mockResolvedValue(null);
    vi.mocked(writeRunListValidator).mockResolvedValue(undefined);
    vi.mocked(writeRuns).mockResolvedValue(undefined);
    vi.mocked(writeCollectionState).mockResolvedValue(undefined);
    vi.mocked(persistCollectionWindow).mockResolvedValue(undefined);
  });

  it('recognizes GitHub rate limit errors from response headers', () => {
    expect(
      isGitHubRateLimitError({
        status: 403,
        response: {
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1712345678',
          },
        },
      })
    ).toBe(true);
  });

  it('recognizes rate limit errors even when the status is not 403', () => {
    expect(
      isGitHubRateLimitError({
        status: 429,
        response: {
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1712345678',
          },
        },
      })
    ).toBe(true);
  });

  it('recognizes secondary rate limit messages', () => {
    expect(
      isGitHubRateLimitError({
        status: 403,
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      })
    ).toBe(true);
  });

  it('recognizes abuse throttling responses that include a retry-after header', () => {
    expect(
      isGitHubRateLimitError({
        status: 403,
        message: 'Request blocked by the abuse detection mechanism.',
        response: {
          headers: {
            'retry-after': '60',
          },
        },
      })
    ).toBe(true);
  });

  it('does not checkpoint an incomplete window when rate limited mid-collection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));
    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-13', dates: ['2026-04-13'], historyComplete: true });

    const octokit = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            workflow_runs: [
              {
                id: 101,
                name: 'CI',
                head_branch: 'main',
                head_sha: 'sha-101',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-14T10:00:00Z',
                updated_at: '2026-04-14T10:10:00Z',
                html_url: 'https://example.com/runs/101',
              },
              {
                id: 102,
                name: 'CI',
                head_branch: 'main',
                head_sha: 'sha-102',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-14T11:00:00Z',
                updated_at: '2026-04-14T11:10:00Z',
                html_url: 'https://example.com/runs/102',
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            jobs: [
              {
                id: 201,
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-14T10:00:00Z',
                started_at: '2026-04-14T10:01:00Z',
                completed_at: '2026-04-14T10:10:00Z',
                html_url: 'https://example.com/jobs/201',
              },
            ],
          },
        })
        .mockRejectedValueOnce({
          status: 403,
          response: {
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1712345678',
            },
          },
        }),
    };

    await expect(
      collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: false })
    ).rejects.toBeInstanceOf(RateLimitAbortError);

    expect(vi.mocked(persistCollectionWindow)).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resumes after a checkpointed empty Collection Window instead of re-querying it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:00Z'));

    const repo = 'acme/widgets';
    let persistedState: Awaited<ReturnType<typeof readCollectionState>> = {
      backfillCursor: '2026-04-11',
      historyComplete: false,
      latestDate: '2026-04-13',
      retentionDays: 2,
      lastUpdated: null,
    };
    vi.mocked(readCollectionState).mockImplementation(async () => persistedState);
    vi.mocked(getCollectedDates).mockResolvedValue(['2026-04-13']);
    vi.mocked(persistCollectionWindow).mockImplementation(async (_repo, _batches, state) => {
      persistedState = state;
    });

    try {
      await collectRepo(
        { request: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }) } as never,
        repo,
        2,
        { forceFullBackfill: false, reverse: false, skipJobs: true },
        undefined,
        [{ start: '2026-04-11', end: '2026-04-11' }],
      );

      expect(persistedState).toMatchObject({ backfillCursor: '2026-04-12', historyComplete: false });

      const requestedWindows: string[] = [];
      const request = vi.fn().mockImplementation((_route, params: Record<string, unknown>) => {
        requestedWindows.push(String(params.created));
        if (requestedWindows.length === 1) return Promise.resolve({ data: { workflow_runs: [] } });
        return Promise.reject({
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        });
      });
      await expect(
        collectRepo({ request } as never, repo, 2, { forceFullBackfill: false, reverse: false, skipJobs: true }),
      ).rejects.toBeInstanceOf(RateLimitAbortError);

      expect(requestedWindows).toEqual([
        '2026-04-13T00:00:00Z..2026-04-13T23:59:59Z',
        '2026-04-12T00:00:00Z..2026-04-12T23:59:59Z',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the latest range first when history is marked incomplete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:00Z'));

    try {
      const repo = 'acme/widgets';
      const requests: Array<{ route: string; created?: string }> = [];
      const octokit = {
        request: vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
          requests.push({ route, created: typeof params.created === 'string' ? params.created : undefined });

          if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
            return Promise.reject({
              status: 403,
              response: {
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': '1712345678',
                },
              },
            });
          }

          throw new Error(`Unexpected request: ${route}`);
        }),
      };

      mockRepoState({ latest: '2026-04-12', dates: ['2026-04-12', '2026-04-11'], historyComplete: false });

      await expect(
        collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: false })
      ).rejects.toBeInstanceOf(RateLimitAbortError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the latest range before resuming history collection from the stored cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:00Z'));

    try {
      const repo = 'acme/widgets';
      const requests: Array<{ route: string; created?: string }> = [];
      const octokit = {
        request: vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
          requests.push({ route, created: typeof params.created === 'string' ? params.created : undefined });

          if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
            return Promise.reject({
              status: 403,
              response: {
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': '1712345678',
                },
              },
            });
          }

          throw new Error(`Unexpected request: ${route}`);
        }),
      };

      mockRepoState({
        latest: '2026-04-12',
        dates: ['2026-04-12', '2026-04-11'],
        historyComplete: false,
        backfillCursor: '2026-03-01',
      });

      await expect(
        collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: false })
      ).rejects.toBeInstanceOf(RateLimitAbortError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads repo state and collected dates from SQLite when Turso is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:00Z'));
    process.env.ENABLE_SQLITE_FALLBACK = '1';

    try {
      const repo = 'acme/widgets';
      const requests: Array<{ route: string; created?: string }> = [];
      const octokit = {
        request: vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
          requests.push({ route, created: typeof params.created === 'string' ? params.created : undefined });

          if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
            return Promise.reject({
              status: 403,
              response: {
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': '1712345678',
                },
              },
            });
          }

          throw new Error(`Unexpected request: ${route}`);
        }),
      };

      mockRepoState({
        latest: '2026-04-12',
        dates: ['2026-04-12', '2026-04-11'],
        historyComplete: false,
        backfillCursor: '2026-03-01',
      });

      await expect(
        collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: false })
      ).rejects.toBeInstanceOf(RateLimitAbortError);

      expect(vi.mocked(writeCollectionState)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports reverse collection from today back toward older history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:00Z'));

    try {
      const repo = 'acme/widgets';
      const requests: Array<{ route: string; created?: string }> = [];
      const octokit = {
        request: vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
          requests.push({ route, created: typeof params.created === 'string' ? params.created : undefined });

          if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
            return Promise.reject({
              status: 403,
              response: {
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': '1712345678',
                },
              },
            });
          }

          throw new Error(`Unexpected request: ${route}`);
        }),
      };

      mockRepoState({
        latest: '2026-04-12',
        dates: ['2026-04-12', '2026-04-11'],
        historyComplete: false,
        backfillCursor: '2026-03-01',
      });

      await expect(
        collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: true })
      ).rejects.toBeInstanceOf(RateLimitAbortError);

      expect(requests[0]).toEqual({
        route: 'GET /repos/{owner}/{repo}/actions/runs',
        created: '2026-04-12T00:00:00Z..2026-04-13T23:59:59Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when a later rate limit would otherwise hide an earlier repo failure', async () => {
    const collectRepoImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('repository config is invalid'))
      .mockRejectedValueOnce(
        new RateLimitAbortError('GitHub API rate limit reached (remaining=0, limit=5000, reset=1712345678)')
      );

    await expect(
      runCollection({
        token: 'token',
        retentionDays: 90,
        cliOptions: { forceFullBackfill: false, reverse: false },
        targetRepos: ['acme/widgets', 'acme/other', 'acme/more'],
        octokit: {} as never,
        collectRepoImpl,
      })
    ).rejects.toThrow('Collection failed for 1 repos');

    expect(collectRepoImpl).toHaveBeenCalledTimes(2);
  });

  it('stops immediately and reports a normal completion when a repo hits rate limit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const collectRepoImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new RateLimitAbortError('GitHub API rate limit reached (remaining=0, limit=5000, reset=1712345678)')
      );

    await expect(
      runCollection({
        token: 'token',
        retentionDays: 90,
        cliOptions: { forceFullBackfill: false, reverse: false },
        targetRepos: ['acme/widgets', 'acme/other'],
        octokit: {} as never,
        collectRepoImpl,
      })
    ).resolves.toBeUndefined();

    expect(collectRepoImpl).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      'GitHub API rate limit reached (remaining=0, limit=5000, reset=1712345678)'
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Stopping collection early. Partial results were saved and the next run can resume from the updated index.'
    );
  });

  it('does not checkpoint or fetch jobs before a saturated split completes', async () => {
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        callback();
      }

      return 0 as never;
    }) as typeof setTimeout);

    vi.resetModules();
    vi.doMock('../../src/lib/collection-windows.ts', () => {
      const actual = vi.importActual<typeof import('../../src/lib/collection-windows')>(
        '../../src/lib/collection-windows.ts'
      );

      return actual.then(mod => ({
        ...mod,
        default: {
          ...mod.default,
          buildCollectionWindows: () => [{ start: '2026-04-01', end: '2026-04-15' }],
          splitCollectionWindow: () => [
            { start: '2026-04-01', end: '2026-04-08' },
            { start: '2026-04-08', end: '2026-04-15' },
          ],
        },
      }));
    });

    const { collectRepo: isolatedCollectRepo, RateLimitAbortError: IsolatedRateLimitAbortError } = await import(
      './collect'
    );

    const repo = 'acme/widgets';
    const topWindow = '2026-04-01T00:00:00Z..2026-04-15T23:59:59Z';
    const childOneWindow = '2026-04-01T00:00:00Z..2026-04-08T23:59:59Z';
    const childTwoWindow = '2026-04-08T00:00:00Z..2026-04-15T23:59:59Z';

    const octokit = {
      request: vi.fn().mockImplementation((_route, params: Record<string, unknown>) => {
        if (typeof params.created === 'string') {
          if (params.created === topWindow) {
            return Promise.resolve({
              data: {
                workflow_runs: new Array(100).fill(null).map((_, index) => ({
                  id: index + 1,
                  name: `CI ${index + 1}`,
                  head_branch: 'main',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-04-14T10:00:00Z',
                  updated_at: '2026-04-14T10:10:00Z',
                  html_url: `https://example.com/runs/${index + 1}`,
                })),
              },
            });
          }

          if (params.created === childOneWindow) {
            return Promise.resolve({
              data: {
                workflow_runs: [
                  {
                    id: 101,
                    name: 'older CI',
                    head_branch: 'main',
                    status: 'completed',
                    conclusion: 'success',
                    created_at: '2026-04-10T10:00:00Z',
                    updated_at: '2026-04-10T10:10:00Z',
                    html_url: 'https://example.com/runs/101',
                  },
                ],
              },
            });
          }

          if (params.created === childTwoWindow) {
            return Promise.reject({
              status: 403,
              response: {
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': '1712345678',
                },
              },
            });
          }
        }

        if (typeof params.run_id === 'number') {
          return Promise.resolve({
            data: {
              jobs: [
                {
                  id: Number(params.run_id) + 1000,
                  name: 'build',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-04-10T10:00:00Z',
                  started_at: '2026-04-10T10:01:00Z',
                  completed_at: '2026-04-10T10:10:00Z',
                  html_url: `https://example.com/jobs/${params.run_id}`,
                },
              ],
            },
          });
        }

        throw new Error(`Unexpected request: ${JSON.stringify(params)}`);
      }),
    };

    await expect(
      isolatedCollectRepo(octokit as never, repo, 90, { forceFullBackfill: true, reverse: false })
    ).rejects.toBeInstanceOf(IsolatedRateLimitAbortError);

    expect(vi.mocked(persistCollectionWindow)).not.toHaveBeenCalled();
    expect(octokit.request).not.toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      expect.anything(),
    );
  });

  it('persists validators only for unsaturated child windows', async () => {
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as never;
    }) as typeof setTimeout);

    vi.resetModules();
    vi.doMock('../../src/lib/collection-windows.ts', () => {
      const actual = vi.importActual<typeof import('../../src/lib/collection-windows')>(
        '../../src/lib/collection-windows.ts'
      );

      return actual.then(mod => ({
        ...mod,
        default: {
          ...mod.default,
          buildCollectionWindows: () => [{ start: '2026-04-01', end: '2026-04-15' }],
          splitCollectionWindow: () => [
            { start: '2026-04-01', end: '2026-04-08' },
            { start: '2026-04-08', end: '2026-04-15' },
          ],
        },
      }));
    });

    const { collectRepo: isolatedCollectRepo } = await import('./collect');
    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-01', dates: ['2026-04-01'], historyComplete: true });

    const request = vi.fn().mockImplementation((_route, params: Record<string, unknown>) => {
      const created = String(params.created);
      if (created === '2026-04-01T00:00:00Z..2026-04-15T23:59:59Z') {
        return Promise.resolve({
          data: {
            workflow_runs: new Array(100).fill(null).map((_, index) => ({
              id: index + 1,
              name: `CI ${index + 1}`,
              head_branch: 'main',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-04-14T10:00:00Z',
              updated_at: '2026-04-14T10:10:00Z',
              html_url: `https://example.com/runs/${index + 1}`,
            })),
          },
          headers: { etag: '"saturated-parent"' },
        });
      }

      return Promise.resolve({
        data: { workflow_runs: [] },
        headers: { etag: `"${created}"` },
      });
    });

    await isolatedCollectRepo(
      { request } as never,
      repo,
      90,
      { forceFullBackfill: false, reverse: false, skipJobs: true },
      { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
    );

    expect(writeRunListValidator).not.toHaveBeenCalledWith(
      repo,
      'ci.yml',
      '2026-04-01',
      '2026-04-15',
      '"saturated-parent"',
    );
    expect(writeRunListValidator).toHaveBeenCalledTimes(2);
  });

  it('does not delete expired day files since Turso is source of truth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00Z'));

    const repo = 'adapter-cleanup-test/widgets';
    const expiredDate = '2026-04-13';

    try {
      const octokit = {
        request: vi
          .fn()
          .mockResolvedValueOnce({
            data: {
              workflow_runs: [
                {
                  id: 101,
                  name: 'CI',
                  head_branch: 'main',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-04-16T10:00:00Z',
                  updated_at: '2026-04-16T10:10:00Z',
                  html_url: 'https://example.com/runs/101',
                },
              ],
            },
          })
          .mockResolvedValueOnce({
            data: {
              jobs: [
                {
                  id: 201,
                  name: 'build',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-04-16T10:00:00Z',
                  started_at: '2026-04-16T10:01:00Z',
                  completed_at: '2026-04-16T10:10:00Z',
                  html_url: 'https://example.com/jobs/201',
                },
              ],
            },
          }),
      };

      mockRepoState({
        latest: '2026-04-15',
        dates: ['2026-04-15', expiredDate],
        historyComplete: true,
        retentionDays: 2,
      });

      await collectRepo(octokit as never, repo, 2, { forceFullBackfill: false, reverse: false });

      expect(vi.mocked(persistCollectionWindow)).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches jobs for existing runs when steps have not been checked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });
    vi.mocked(getExistingRunIds).mockResolvedValue(new Set([101]));
    vi.mocked(getCachedWorkflowAttempts).mockResolvedValue(new Map());

    const request = vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
        return Promise.resolve({
          data: {
            workflow_runs: [
              {
                id: 101,
                name: 'CI',
                head_branch: 'main',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T10:00:00Z',
                updated_at: '2026-04-18T10:10:00Z',
                html_url: 'https://example.com/runs/101',
              },
            ],
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
        return Promise.resolve({
          data: {
            jobs: [
              {
                id: 201,
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T10:00:00Z',
                started_at: '2026-04-18T10:01:00Z',
                completed_at: '2026-04-18T10:10:00Z',
                html_url: 'https://example.com/jobs/201',
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected request: ${route} ${JSON.stringify(params)}`);
    });

    try {
      await collectRepo({ request } as never, repo, 90, { forceFullBackfill: false, reverse: false });
    } finally {
      vi.useRealTimers();
    }

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      expect.objectContaining({ run_id: 101 })
    );
  });

  it('refetches jobs when a cached run was updated on GitHub after the stored version', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });
    vi.mocked(getCachedWorkflowAttempts).mockResolvedValue(
      new Map([['101:1', { updatedAt: '2026-04-18T10:05:00Z', stepPolicyHash: null }]])
    );

    const request = vi.fn().mockImplementation((route: string, params: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
        return Promise.resolve({
          data: {
            workflow_runs: [
              {
                id: 101,
                name: 'CI',
                head_branch: 'main',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T10:00:00Z',
                updated_at: '2026-04-18T10:10:00Z',
                html_url: 'https://example.com/runs/101',
              },
            ],
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
        return Promise.resolve({
          data: {
            jobs: [
              {
                id: 201,
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T10:00:00Z',
                started_at: '2026-04-18T10:01:00Z',
                completed_at: '2026-04-18T10:10:00Z',
                html_url: 'https://example.com/jobs/201',
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected request: ${route} ${JSON.stringify(params)}`);
    });

    try {
      await collectRepo({ request } as never, repo, 90, { forceFullBackfill: false, reverse: false });
    } finally {
      vi.useRealTimers();
    }

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      expect.objectContaining({ run_id: 101 })
    );
  });

  it('skips parse, writes, and jobs when a recent tracked-workflow run list is unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });
    vi.mocked(readRunListValidator).mockResolvedValue('"cached-etag"');

    const request = vi.fn().mockRejectedValue({ status: 304 });

    try {
      await collectRepo(
        { request } as never,
        repo,
        90,
        { forceFullBackfill: false, reverse: false },
        { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      expect.objectContaining({
        workflow_id: 'ci.yml',
        created: '2026-04-17T00:00:00Z..2026-04-18T23:59:59Z',
        headers: { 'if-none-match': '"cached-etag"' },
      }),
    );
    expect(getCachedWorkflowAttempts).not.toHaveBeenCalled();
    expect(writeRuns).not.toHaveBeenCalled();
    expect(writeWorkflowAttempts).not.toHaveBeenCalled();
    expect(writeCollectionState).not.toHaveBeenCalled();
    expect(writeRunListValidator).not.toHaveBeenCalled();
  });

  it('persists a deduplicated Collection Window and checkpoint before its validator', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });
    const request = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 101,
            run_attempt: 1,
            name: 'CI',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-04-18T10:00:00Z',
            updated_at: '2026-04-18T10:10:00Z',
            html_url: 'https://example.com/runs/101',
            path: '.github/workflows/ci.yml@main',
          },
          {
            id: 101,
            run_attempt: 1,
            name: 'CI duplicate',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-04-18T10:00:00Z',
            updated_at: '2026-04-18T10:10:00Z',
            html_url: 'https://example.com/runs/101',
            path: '.github/workflows/ci.yml@main',
          },
        ],
      },
      headers: { etag: '"new-etag"' },
    });

    try {
      await collectRepo(
        { request } as never,
        repo,
        90,
        { forceFullBackfill: false, reverse: false, skipJobs: true },
        { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(persistCollectionWindow).toHaveBeenCalledWith(
      repo,
      [expect.objectContaining({ date: '2026-04-18', runs: [expect.objectContaining({ id: 101 })] })],
      expect.objectContaining({ latestDate: '2026-04-18' }),
    );
    expect(vi.mocked(persistCollectionWindow).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(writeRunListValidator).mock.invocationCallOrder[0],
    );
  });

  it('stores a changed recent run-list validator after its checkpoint succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });
    const request = vi.fn().mockResolvedValue({
      data: { workflow_runs: [] },
      headers: { etag: '"new-etag"' },
    });

    try {
      await collectRepo(
        { request } as never,
        repo,
        90,
        { forceFullBackfill: false, reverse: false, skipJobs: true },
        { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(writeRunListValidator).toHaveBeenCalledWith(
      repo,
      'ci.yml',
      '2026-04-17',
      '2026-04-18',
      '"new-etag"',
    );
    expect(vi.mocked(persistCollectionWindow).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(writeRunListValidator).mock.invocationCallOrder[0],
    );
  });

  it('skips job fetches in workflow-only mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });

    const request = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs') {
        return Promise.resolve({
          data: {
            workflow_runs: [
              {
                id: 101,
                name: 'CI',
                head_branch: 'main',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T10:00:00Z',
                updated_at: '2026-04-18T10:10:00Z',
                html_url: 'https://example.com/runs/101',
                path: '.github/workflows/ci.yml@main',
              },
            ],
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
        throw new Error('jobs endpoint should not be called in workflow-only mode');
      }

      throw new Error(`Unexpected request: ${route}`);
    });

    try {
      await collectRepo(
        { request } as never,
        repo,
        90,
        { forceFullBackfill: false, reverse: false, skipJobs: true },
        { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      expect.objectContaining({ workflow_id: 'ci.yml', created: '2026-04-17T00:00:00Z..2026-04-18T23:59:59Z' })
    );
  });

  it('keeps the exact retention-boundary day file when pruning old data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T11:55:15.104Z'));

    const repo = 'boundary-retention-test/widgets';

    try {
      const octokit = {
        request: vi
          .fn()
          .mockResolvedValueOnce({
            data: {
              workflow_runs: [
                {
                  id: 101,
                  name: 'CI',
                  head_branch: 'main',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-01-18T10:00:00Z',
                  updated_at: '2026-01-18T10:10:00Z',
                  html_url: 'https://example.com/runs/101',
                },
              ],
            },
          })
          .mockResolvedValueOnce({
            data: {
              jobs: [
                {
                  id: 201,
                  name: 'build',
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-01-18T10:00:00Z',
                  started_at: '2026-01-18T10:01:00Z',
                  completed_at: '2026-01-18T10:10:00Z',
                  html_url: 'https://example.com/jobs/201',
                },
              ],
            },
          }),
      };

      mockRepoState({
        latest: '2026-04-17',
        dates: ['2026-04-17'],
        historyComplete: true,
      });

      await collectRepo(octokit as never, repo, 90, { forceFullBackfill: false, reverse: false });

      expect(vi.mocked(persistCollectionWindow)).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves separate attempts for the same run id and keeps non-terminal attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));

    const repo = 'acme/widgets';
    mockRepoState({ latest: '2026-04-17', dates: ['2026-04-17'], historyComplete: true });

    const request = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs') {
        return Promise.resolve({
          data: {
            workflow_runs: [
              {
                id: 101,
                run_attempt: 1,
                name: 'CI',
                head_branch: 'main',
                status: 'completed',
                conclusion: 'failure',
                created_at: '2026-04-18T09:00:00Z',
                updated_at: '2026-04-18T09:10:00Z',
                html_url: 'https://example.com/runs/101',
                path: '.github/workflows/ci.yml@main',
              },
              {
                id: 101,
                run_attempt: 2,
                name: 'CI',
                head_branch: 'main',
                status: 'in_progress',
                conclusion: null,
                created_at: '2026-04-18T09:20:00Z',
                updated_at: '2026-04-18T09:25:00Z',
                html_url: 'https://example.com/runs/101/attempts/2',
                path: '.github/workflows/ci.yml@main',
              },
            ],
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
        return Promise.resolve({ data: { jobs: [] } });
      }

      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
        return Promise.resolve({ data: { jobs: [] } });
      }

      throw new Error(`Unexpected request: ${route}`);
    });

    try {
      await collectRepo(
        { request } as never,
        repo,
        90,
        { forceFullBackfill: false, reverse: false },
        { repos: [{ repo, workflows: [{ file: 'ci.yml' }] }] },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(vi.mocked(getCachedWorkflowAttempts)).toHaveBeenCalledWith(repo, [
      { runId: 101, runAttempt: 1 },
      { runId: 101, runAttempt: 2 },
    ]);
    expect(vi.mocked(persistCollectionWindow)).toHaveBeenCalledWith(
      repo,
      [expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({ run_id: 101, run_attempt: 1, status: 'completed' }),
          expect.objectContaining({ run_id: 101, run_attempt: 2, status: 'in_progress' }),
        ]),
      })],
      expect.anything(),
    );
  });

  it('reports shared-collection heartbeats and terminal counts', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);
    let finishCollection!: () => void;
    const collectionFinished = new Promise<void>(resolve => { finishCollection = resolve; });

    try {
      const scheduled = runSharedCollectionPlan({
        tokens: ['token'],
        work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
        retentionDays: 90,
        cliOptions: { forceFullBackfill: false, reverse: false },
        reposConfig: { repos: [] },
        collectRepoImpl: vi.fn(() => collectionFinished) as never,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(logSpy).toHaveBeenCalledWith(
        'Collection heartbeat: completed=0, failures=0, pending=0, retries=0, active=lane=user:1 (collector) repo=acme/a workflow=all window=2026-04-17..2026-04-18 phase=running budget=12',
      );

      finishCollection();
      await scheduled;
      expect(logSpy).toHaveBeenCalledWith('Collection summary: completed=1, failures=0, deferred=0, retries=0');
      expect(logSpy).toHaveBeenCalledWith('Repository summary: repo=acme/a completed=1 failures=0 deferred=0 total=1 cachedAttempts=0 retries=0 duration=30s');
      expect(logSpy).toHaveBeenCalledWith('Identity lane summary: lane=user:1 (collector) completed=1 failures=0 deferred=0 retries=0 remainingBudget=12 duration=30s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('identifies failed windows in the shared terminal summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    const result = await runSharedCollectionPlan({
      tokens: ['token'],
      work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn().mockRejectedValue(new Error('network failed')) as never,
    });

    expect(result).toMatchObject({ completed: 0, total: 1, failures: ['acme/a (2026-04-17..2026-04-18): network failed'], deferred: 0, retries: 0 });
    expect(logSpy).toHaveBeenCalledWith('Collection summary: completed=0, failures=1, deferred=0, retries=0');
  });

  it('reassigns a rate-limited window and reports its cooldown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'first' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    const secondClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 2, login: 'second' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit')
      .mockReturnValueOnce(firstClient as never)
      .mockReturnValueOnce(secondClient as never);
    const collected: string[] = [];
    let limitOnce = true;

    await runSharedCollectionPlan({
      tokens: ['first-token', 'second-token'],
      work: [
        { repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
        { repo: 'acme/b', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
      ],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async (_client, repo) => {
        if (limitOnce) {
          limitOnce = false;
          throw new RateLimitAbortError('primary limit', [], { remaining: '0', reset: '1712345678' });
        }
        collected.push(repo);
      }) as never,
    });

    expect(collected).toEqual(expect.arrayContaining(['acme/a', 'acme/b']));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('identity lane user:1 (first) cooldown=until=2024-04-05T19:34:38.000Z.'));
  });

  it('retries a secondary-limited lane after Retry-After expires', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);
    const collectRepoImpl = vi.fn()
      .mockRejectedValueOnce(new RateLimitAbortError('secondary limit', [], { remaining: '12', retryAfter: '60' }))
      .mockResolvedValueOnce(undefined);

    try {
      const scheduled = runSharedCollectionPlan({
        tokens: ['token'],
        work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
        retentionDays: 90,
        cliOptions: { forceFullBackfill: false, reverse: false },
        reposConfig: { repos: [] },
        collectRepoImpl: collectRepoImpl as never,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(scheduled).resolves.toMatchObject({ completed: 1, total: 1, failures: [], deferred: 0, retries: 0 });
      expect(collectRepoImpl).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cooldown=60s.'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports only terminally deferred Collection Windows', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    await expect(runSharedCollectionPlan({
      tokens: ['token'],
      work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn().mockRejectedValue(new RateLimitAbortError('primary limit', [], { remaining: '0' })) as never,
    })).resolves.toMatchObject({ completed: 0, total: 1, failures: [], deferred: 1, retries: 0 });

    expect(warnSpy).toHaveBeenCalledWith('Collection windows deferred: acme/a (2026-04-17..2026-04-18)');
  });

  it('shares identity lanes, prioritizes recent windows, and preserves the request reserve', async () => {
    const requests: string[] = [];
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        requests.push(route);
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    const collected: string[] = [];
    await runSharedCollectionPlan({
      tokens: ['first-token', 'second-token'],
      work: [
        { repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
        { repo: 'acme/b', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
        { repo: 'acme/a', window: { start: '2026-04-10', end: '2026-04-16' }, priority: 1 },
      ],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async (client, repo, _days, _options, _config, windows) => {
        collected.push(`${repo}:${windows?.[0].start}`);
        await client.request('GET /work');
      }) as never,
    });

    expect(collected.slice(0, 2)).toEqual(['acme/a:2026-04-17', 'acme/b:2026-04-17']);
    expect(requests.filter(route => route === 'GET /work')).toHaveLength(2);
  });

  it('counts retries and reports them in the shared terminal summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 12 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    let attempts = 0;
    const result = await runSharedCollectionPlan({
      tokens: ['token'],
      work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async () => {
        await withRetry(async () => {
          attempts += 1;
          if (attempts === 1) {
            const err = new Error('deadlock') as Error & { code: string };
            err.code = '40P01';
            throw err;
          }
        }, 3, 1);
      }) as never,
    });

    expect(result).toMatchObject({ completed: 1, total: 1, failures: [], deferred: 0, retries: 1 });
    expect(logSpy).toHaveBeenCalledWith('Collection summary: completed=1, failures=0, deferred=0, retries=1');
  });

  it('reports reset cooldown when identity lane depletes its budget reserve', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 10, reset: 1712345678 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    const result = await runSharedCollectionPlan({
      tokens: ['token'],
      work: [{ repo: 'acme/a', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async (client) => {
        await client.request('GET /any');
      }) as never,
    });

    expect(result.deferred).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cooldown=until=2024-04-05T19:34:38.000Z.'));
  });

  it('ends partial with coverage reporting when collection windows are deferred', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 10, reset: 1712345678 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    await expect(runCollection({
      tokens: ['token'],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      targetRepos: ['acme/a'],
      reposConfig: { repos: [{ repo: 'acme/a', workflows: [] }] },
      collectRepoImpl: vi.fn(async (client) => {
        await client.request('GET /exhaust');
      }) as never,
    })).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Collection ended partial: completed=0/'));
    expect(checkEtlFreshness).toHaveBeenCalledWith('acme/a');
  });

  it('tolerates post-collection freshness lookup errors without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(checkEtlFreshness).mockRejectedValueOnce(new Error('pg connection lost'));
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 50 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    await expect(runCollection({
      tokens: ['token'],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      targetRepos: ['acme/a'],
      reposConfig: { repos: [{ repo: 'acme/a', workflows: [] }] },
      collectRepoImpl: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBeUndefined();

    expect(checkEtlFreshness).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to check ETL freshness for acme/a:',
      expect.any(Error),
    );
  });

  it('emits slow-operation warnings when a unit exceeds the slow threshold', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 50 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    let finishWork!: () => void;
    const workPromise = new Promise<void>(resolve => { finishWork = resolve; });

    const scheduled = runSharedCollectionPlan({
      tokens: ['token'],
      work: [{ repo: 'acme/slow-repo', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 }],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [{ repo: 'acme/slow-repo', workflows: [{ workflow: 'ci', file: 'ci.yml', runs: 0, tracked: true }] }] },
      collectRepoImpl: vi.fn(async (_client, _repo, _days, _opts, _cfg, _windows, onPhaseChange) => {
        onPhaseChange?.('jobs');
        await workPromise;
      }) as never,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalledWith(
      'Collection slow-operation: lane=user:1 (collector) repo=acme/slow-repo window=2026-04-17..2026-04-18 phase=jobs elapsed=30s',
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalledWith(
      'Collection slow-operation: lane=user:1 (collector) repo=acme/slow-repo window=2026-04-17..2026-04-18 phase=jobs elapsed=60s',
    );

    finishWork();
    await scheduled;
    vi.useRealTimers();
  });

  it('emits concise stable key=value unit start, done, and failed events', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 1, login: 'collector' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 50 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    await runSharedCollectionPlan({
      tokens: ['token'],
      work: [
        { repo: 'acme/ok', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
        { repo: 'acme/fail', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 1 },
      ],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async (_client, repo) => {
        if (repo === 'acme/fail') throw new Error('disk full');
      }) as never,
    });

    expect(logSpy).toHaveBeenCalledWith(
      'Collection unit start: lane=user:1 (collector) repo=acme/ok window=2026-04-17..2026-04-18 priority=0',
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Collection unit done: lane=user:1 \(collector\) repo=acme\/ok window=2026-04-17\.\.2026-04-18 duration=\d+ms$/),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Collection unit start: lane=user:1 (collector) repo=acme/fail window=2026-04-17..2026-04-18 priority=1',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Collection unit failed: lane=user:1 \(collector\) repo=acme\/fail window=2026-04-17\.\.2026-04-18 duration=\d+ms error="disk full"$/),
    );
  });

  it('aggregates per-repository and per-lane terminal metrics across multi-repo runs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeClient = {
      request: vi.fn(async (route: string) => {
        if (route === 'GET /user') return { data: { id: 10, login: 'lane-a' }, headers: {} };
        if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining: 100 } } }, headers: {} };
        return { data: {}, headers: {} };
      }),
    };
    vi.spyOn(github, 'createOctokit').mockReturnValue(fakeClient as never);

    const result = await runSharedCollectionPlan({
      tokens: ['token-a'],
      work: [
        { repo: 'acme/first', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
        { repo: 'acme/first', window: { start: '2026-04-10', end: '2026-04-16' }, priority: 1 },
        { repo: 'acme/second', window: { start: '2026-04-17', end: '2026-04-18' }, priority: 0 },
      ],
      retentionDays: 90,
      cliOptions: { forceFullBackfill: false, reverse: false },
      reposConfig: { repos: [] },
      collectRepoImpl: vi.fn(async (_client, repo, _days, _opts, _cfg, windows) => {
        if (repo === 'acme/first' && windows?.[0].start === '2026-04-17') {
          return { cachedAttempts: 5, collectedRuns: 10 };
        }
        return { cachedAttempts: 2, collectedRuns: 4 };
      }) as never,
    });

    expect(result.completed).toBe(3);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toBe(0);

    expect(result.repositories['acme/first']).toMatchObject({
      repo: 'acme/first',
      completed: 2,
      failures: 0,
      deferred: 0,
      total: 2,
      cachedAttempts: 7,
      retries: 0,
      durationMs: expect.any(Number),
    });
    expect(result.repositories['acme/second']).toMatchObject({
      repo: 'acme/second',
      completed: 1,
      failures: 0,
      deferred: 0,
      total: 1,
      cachedAttempts: 2,
      retries: 0,
      durationMs: expect.any(Number),
    });

    expect(result.lanes['user:10 (lane-a)']).toMatchObject({
      identity: 'user:10 (lane-a)',
      completed: 3,
      failures: 0,
      deferred: 0,
      retries: 0,
      remainingBudget: 100,
      durationMs: expect.any(Number),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Repository summary: repo=acme\/first completed=2 failures=0 deferred=0 total=2 cachedAttempts=7 retries=0 duration=\d+s$/),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Repository summary: repo=acme\/second completed=1 failures=0 deferred=0 total=1 cachedAttempts=2 retries=0 duration=\d+s$/),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Identity lane summary: lane=user:10 \(lane-a\) completed=3 failures=0 deferred=0 retries=0 remainingBudget=100 duration=\d+s$/),
    );
  });
});
