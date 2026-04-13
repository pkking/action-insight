import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRuns } from './data-fetcher';

describe('fetchRuns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches files within the requested custom date range', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: ['2026-04-12.json', '2026-04-10.json', '2026-04-05.json', '2026-04-01.json'],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [{ id: 10 }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [{ id: 7 }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [{ id: 5 }] }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchRuns('foo', 'bar', {
      startDate: '2026-04-01',
      endDate: '2026-04-10',
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/data/foo/bar/2026-04-10.json');
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/data/foo/bar/2026-04-05.json');
    expect(fetchMock.mock.calls[3]?.[0]).toContain('/data/foo/bar/2026-04-01.json');
    expect(runs).toEqual([{ id: 10 }, { id: 7 }, { id: 5 }]);
  });

  it('fetches files that fall within the requested rolling day window', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: ['2026-04-13.json', '2026-04-12.json', '2026-04-05.json'],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [{ id: 13 }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [{ id: 12 }] }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchRuns('foo', 'bar', {
      days: 7,
      now: new Date('2026-04-13T12:00:00Z'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/data/foo/bar/2026-04-13.json');
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/data/foo/bar/2026-04-12.json');
    expect(runs).toEqual([{ id: 13 }, { id: 12 }]);
  });
});
