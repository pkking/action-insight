import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPullRequestDetail, fetchPullRequestIndex } from './pr-data-fetcher';

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
});
