import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  collectRepo,
  isGitHubRateLimitError,
  RateLimitAbortError,
  runCollection,
} from './collect';

describe('collect rate limit handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('writes partial results and incomplete-history metadata when rate limit is hit mid-collection', async () => {
    const repo = 'acme/widgets';
    const writes: Array<{ kind: 'day' | 'index'; payload: unknown }> = [];

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
                created_at: '2026-04-14T10:00:00Z',
                updated_at: '2026-04-14T10:10:00Z',
                html_url: 'https://example.com/runs/101',
              },
              {
                id: 102,
                name: 'CI',
                head_branch: 'main',
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
      collectRepo(octokit as never, repo, 90, { forceFullBackfill: false }, {
        readIndex: () => ({
          version: 1,
          latest: '2026-04-13',
          files: ['2026-04-13.json'],
          retention_days: 90,
          last_updated: '2026-04-13T00:00:00Z',
          history_complete: true,
        }),
        writeIndex: (_repo, index) => {
          writes.push({ kind: 'index', payload: index });
        },
        readDayData: () => ({ date: '2026-04-14', repo, runs: [] }),
        writeDayData: (_repo, data) => {
          writes.push({ kind: 'day', payload: data });
        },
      })
    ).rejects.toBeInstanceOf(RateLimitAbortError);

    expect(writes).toEqual([
      {
        kind: 'day',
        payload: expect.objectContaining({
          date: '2026-04-14',
          repo,
          runs: expect.arrayContaining([expect.objectContaining({ id: 101 })]),
        }),
      },
      {
        kind: 'index',
        payload: expect.objectContaining({
          latest: '2026-04-14',
          files: ['2026-04-14.json', '2026-04-13.json'],
          history_complete: false,
        }),
      },
    ]);
  });

  it('rebuilds the full retention range at the collector call site when history is marked incomplete', async () => {
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

      await expect(
        collectRepo(octokit as never, repo, 90, { forceFullBackfill: false }, {
          readIndex: () => ({
            version: 1,
            latest: '2026-04-12',
            files: ['2026-04-12.json', '2026-04-11.json'],
            retention_days: 90,
            last_updated: '2026-04-12T00:00:00Z',
            history_complete: false,
          }),
          writeIndex: vi.fn(),
          readDayData: (_repo, date) => ({ date, repo, runs: [] }),
          writeDayData: vi.fn(),
        })
      ).rejects.toBeInstanceOf(RateLimitAbortError);

      expect(requests[0]).toEqual({
        route: 'GET /repos/{owner}/{repo}/actions/runs',
        created: '2026-04-06T00:00:00Z..2026-04-13T23:59:59Z',
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
        cliOptions: { forceFullBackfill: false },
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
        cliOptions: { forceFullBackfill: false },
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

  it('keeps completed sibling subwindows when a later split window hits rate limit', async () => {
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
    const writes: Array<{ kind: 'day' | 'index'; payload: unknown }> = [];
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
      isolatedCollectRepo(octokit as never, repo, 90, { forceFullBackfill: true }, {
        readIndex: () => ({
          version: 1,
          latest: '2026-04-13',
          files: ['2026-04-13.json'],
          retention_days: 90,
          last_updated: '2026-04-13T00:00:00Z',
        }),
        writeIndex: (_repo, index) => {
          writes.push({ kind: 'index', payload: index });
        },
        readDayData: (_repo, date) => ({ date, repo, runs: [] }),
        writeDayData: (_repo, data) => {
          writes.push({ kind: 'day', payload: data });
        },
      })
    ).rejects.toBeInstanceOf(IsolatedRateLimitAbortError);

    expect(writes).toEqual([
      {
        kind: 'day',
        payload: expect.objectContaining({
          date: '2026-04-10',
          repo,
          runs: expect.arrayContaining([expect.objectContaining({ id: 101 })]),
        }),
      },
      {
        kind: 'index',
        payload: expect.objectContaining({
          latest: '2026-04-13',
          files: ['2026-04-13.json', '2026-04-10.json'],
        }),
      },
    ]);
  });

  it('removes expired day files through the storage adapter instead of direct fs deletion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00Z'));

    const repo = 'adapter-cleanup-test/widgets';
    const deleteDayData = vi.fn();
    const expiredDate = '2026-04-13';
    const expiredFilePath = path.join(process.cwd(), 'data', 'adapter-cleanup-test', 'widgets', `${expiredDate}.json`);

    try {
      fs.mkdirSync(path.dirname(expiredFilePath), { recursive: true });
      fs.writeFileSync(expiredFilePath, JSON.stringify({ date: expiredDate, repo, runs: [] }));

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

      await collectRepo(octokit as never, repo, 2, { forceFullBackfill: false }, {
        readIndex: () => ({
          version: 1,
          latest: '2026-04-15',
          files: ['2026-04-15.json', `${expiredDate}.json`],
          retention_days: 2,
          last_updated: '2026-04-15T00:00:00Z',
          history_complete: true,
        }),
        writeIndex: vi.fn(),
        readDayData: (_repo, date) => ({ date, repo, runs: [] }),
        writeDayData: vi.fn(),
        deleteDayData,
      });

      expect(deleteDayData).toHaveBeenCalledWith(repo, expiredDate);
      expect(fs.existsSync(expiredFilePath)).toBe(true);
    } finally {
      vi.useRealTimers();
      fs.rmSync(path.join(process.cwd(), 'data', 'adapter-cleanup-test'), { recursive: true, force: true });
    }
  });
});
