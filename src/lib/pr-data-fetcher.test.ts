import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPullRequestDetail, fetchPullRequestIndex, fetchPullRequestIndexes } from './pr-data-fetcher';

describe('pr-data-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the PR index from the precomputed aggregate file', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prs: [{ number: 42 }] }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPullRequestIndex('foo', 'bar');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/data/foo/bar/prs/index.json'),
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(result.prs).toEqual([{ number: 42 }]);
  });

  it('fetches a single PR detail file on demand', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pr: { number: 42 } }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPullRequestDetail('foo', 'bar', 42);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/data/foo/bar/prs/42.json'),
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(result.pr.number).toBe(42);
  });

  it('returns an empty missing-artifact marker when a PR index has not been generated', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPullRequestIndex('foo', 'bar');

    expect(result).toMatchObject({
      repo: 'foo/bar',
      prs: [],
      missingPrArtifact: true,
    });
  });

  it('fetches multiple PR indexes and reports per-repo failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repo: 'foo/bar', prs: [{ number: 1 }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Boom',
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPullRequestIndexes([
      { owner: 'foo', repo: 'bar', key: 'foo/bar' },
      { owner: 'baz', repo: 'qux', key: 'baz/qux' },
    ]);

    expect(result.indexesByRepoKey['foo/bar']).toEqual({ repo: 'foo/bar', prs: [{ number: 1 }] });
    expect(result.failedRepoKeys).toEqual(['baz/qux']);
  });
});
