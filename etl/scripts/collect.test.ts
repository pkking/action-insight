import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectRepo,
  fetchJobsForRunAttempt,
  parseRunnerResourceLabels,
  RateLimitAbortError,
  runCollection,
} from './collect';
import { isGitHubRateLimitError } from './github';

vi.mock('./pg-storage.ts', async () => {
  const actual = await vi.importActual<typeof import('./pg-storage')>('./pg-storage');
  return {
    ...actual,
    readCollectionState: vi.fn().mockResolvedValue(null),
    writeCollectionState: vi.fn().mockResolvedValue(undefined),
    getCollectedDates: vi.fn().mockResolvedValue([]),
    getExistingRunIds: vi.fn().mockResolvedValue(new Set()),
	    getCachedWorkflowAttempts: vi.fn().mockResolvedValue(new Map()),
	    writeRuns: vi.fn().mockResolvedValue(undefined),
	    writeWorkflowAttempts: vi.fn().mockResolvedValue(undefined),
	  };
	});


import {
  readCollectionState,
  writeCollectionState,
  getCollectedDates,
  getExistingRunIds,
  getCachedWorkflowAttempts,
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
    delete process.env.ENABLE_SQLITE_FALLBACK;
    vi.mocked(readCollectionState).mockResolvedValue(null);
    vi.mocked(getCollectedDates).mockResolvedValue([]);
    vi.mocked(getExistingRunIds).mockResolvedValue(new Set());
    vi.mocked(getCachedWorkflowAttempts).mockResolvedValue(new Map());
    vi.mocked(writeRuns).mockResolvedValue(undefined);
    vi.mocked(writeCollectionState).mockResolvedValue(undefined);
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

    expect(vi.mocked(writeCollectionState)).not.toHaveBeenCalled();
    vi.useRealTimers();
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

    expect(vi.mocked(writeCollectionState)).not.toHaveBeenCalled();
    expect(octokit.request).not.toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      expect.anything(),
    );
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

      expect(vi.mocked(writeCollectionState)).toHaveBeenCalled();
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

      expect(vi.mocked(writeCollectionState)).toHaveBeenCalled();
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
    expect(vi.mocked(writeWorkflowAttempts)).toHaveBeenCalledWith(
      repo,
      expect.arrayContaining([
        expect.objectContaining({ run_id: 101, run_attempt: 1, status: 'completed' }),
        expect.objectContaining({ run_id: 101, run_attempt: 2, status: 'in_progress' }),
      ]),
    );
  });
});
