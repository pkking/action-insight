import { describe, expect, it } from 'vitest';

import {
  buildCollectionWindows,
  mergeCollectedDates,
  splitCollectionWindow,
} from './collection-windows';

describe('collection window helpers', () => {
  it('splits an initial 90-day backfill into bounded windows instead of one unbounded query', () => {
    const windows = buildCollectionWindows({
      latest: '',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows).toHaveLength(13);
    expect(windows[0]).toEqual({ start: '2026-04-06', end: '2026-04-13' });
    expect(windows.at(-1)).toEqual({ start: '2026-01-13', end: '2026-01-19' });
  });

  it('uses a single incremental window when prior data already exists', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows).toEqual([{ start: '2026-04-12', end: '2026-04-13' }]);
  });

  it('rebuilds the full retention window when forced even if prior data exists', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
      forceFullBackfill: true,
    });

    expect(windows).toHaveLength(13);
    expect(windows[0]).toEqual({ start: '2026-04-06', end: '2026-04-13' });
    expect(windows.at(-1)).toEqual({ start: '2026-01-13', end: '2026-01-19' });
  });

  it('sorts and de-duplicates collected daily files before retention cleanup', () => {
    expect(
      mergeCollectedDates(['2026-04-12.json', '2026-04-10.json'], ['2026-04-11', '2026-04-10'])
    ).toEqual(['2026-04-12.json', '2026-04-11.json', '2026-04-10.json']);
  });

  it('splits a saturated window into smaller contiguous windows', () => {
    expect(splitCollectionWindow({ start: '2026-04-09', end: '2026-04-10' })).toEqual([
      { start: '2026-04-09T00:00:00Z', end: '2026-04-09T12:00:00Z' },
      { start: '2026-04-09T12:00:00Z', end: '2026-04-10T00:00:00Z' },
    ]);
  });
});
