import { describe, expect, it } from 'vitest';

import {
  buildCollectionWindows,
  mergeCollectedDates,
  splitCollectionWindow,
  toCreatedRange,
} from './collection-windows';

describe('collection window helpers', () => {
  it('splits an initial 90-day backfill into bounded forward windows instead of one unbounded query', () => {
    const windows = buildCollectionWindows({
      latest: '',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start: '2026-01-13', end: '2026-01-20' });
    expect(windows.at(-1)).toEqual({ start: '2026-04-11', end: '2026-04-13' });
  });

  it('continues from the saved backfill cursor by default', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      existingFileCount: 3,
      backfillCursor: '2026-03-01',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows[0]).toEqual({ start: '2026-03-01', end: '2026-03-08' });
    expect(windows.at(-1)).toEqual({ start: '2026-04-10', end: '2026-04-13' });
  });

  it('starts from the earliest retained day when history is explicitly marked incomplete', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      existingFileCount: 3,
      historyComplete: false,
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start: '2026-01-13', end: '2026-01-20' });
    expect(windows.at(-1)).toEqual({ start: '2026-04-11', end: '2026-04-13' });
  });

  it('starts from the earliest retained day when history looks incomplete', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      existingFileCount: 1,
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
    });

    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start: '2026-01-13', end: '2026-01-20' });
    expect(windows.at(-1)).toEqual({ start: '2026-04-11', end: '2026-04-13' });
  });

  it('rebuilds the full retention window from oldest to newest when forced even if prior data exists', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      existingFileCount: 3,
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
      forceFullBackfill: true,
    });

    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start: '2026-01-13', end: '2026-01-20' });
    expect(windows.at(-1)).toEqual({ start: '2026-04-11', end: '2026-04-13' });
  });

  it('supports reverse collection from today back toward older history', () => {
    const windows = buildCollectionWindows({
      latest: '2026-04-12',
      existingFileCount: 3,
      backfillCursor: '2026-03-01',
      retentionDays: 90,
      now: new Date('2026-04-13T00:00:00Z'),
      windowDays: 7,
      reverse: true,
    });

    expect(windows[0]).toEqual({ start: '2026-04-06', end: '2026-04-13' });
    expect(windows.at(-1)).toEqual({ start: '2026-03-01', end: '2026-03-04' });
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

  it('formats a collection window as a raw created-at range', () => {
    expect(toCreatedRange({ start: '2026-04-07', end: '2026-04-14' })).toBe(
      '2026-04-07T00:00:00Z..2026-04-14T23:59:59Z'
    );
  });
});
