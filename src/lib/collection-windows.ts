import { addDays, format, subDays } from 'date-fns';

export interface CollectionWindow {
  start: string;
  end: string;
}

interface BuildCollectionWindowsOptions {
  latest: string;
  existingFileCount?: number;
  historyComplete?: boolean;
  backfillCursor?: string;
  retentionDays: number;
  now?: Date;
  windowDays?: number;
  forceFullBackfill?: boolean;
  reverse?: boolean;
}

const DEFAULT_WINDOW_DAYS = 7;

export function buildCollectionWindows({
  latest,
  existingFileCount = 0,
  historyComplete,
  backfillCursor,
  retentionDays,
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  forceFullBackfill = false,
  reverse = false,
}: BuildCollectionWindowsOptions): CollectionWindow[] {
  const hasIncompleteHistory =
    historyComplete === false ||
    Boolean(backfillCursor) ||
    (historyComplete === undefined && Boolean(latest) && existingFileCount <= 1);
  const today = format(now, 'yyyy-MM-dd');
  const oldest = format(subDays(now, retentionDays), 'yyyy-MM-dd');
  const forwardStart = backfillCursor || oldest;

  if (reverse) {
    return buildReverseCollectionWindows(forwardStart, today, windowDays);
  }

  if (latest && !forceFullBackfill && !hasIncompleteHistory) {
    return [{ start: latest, end: today }];
  }

  if (latest && !forceFullBackfill && hasIncompleteHistory) {
    const recentWindows = buildForwardCollectionWindows(latest, today, windowDays);
    const backfillEnd = format(subDays(new Date(`${latest}T00:00:00Z`), 1), 'yyyy-MM-dd');

    if (forwardStart > backfillEnd) {
      return recentWindows;
    }

    return [...recentWindows, ...buildForwardCollectionWindows(forwardStart, backfillEnd, windowDays)];
  }

  return buildForwardCollectionWindows(forceFullBackfill ? oldest : forwardStart, today, windowDays);
}

function buildForwardCollectionWindows(startDate: string, endDate: string, windowDays: number): CollectionWindow[] {
  const windows: CollectionWindow[] = [];
  let start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (start <= end) {
    const windowEnd = addDays(start, windowDays);
    windows.push({
      start: format(start, 'yyyy-MM-dd'),
      end: format(windowEnd > end ? end : windowEnd, 'yyyy-MM-dd'),
    });

    start = addDays(windowEnd, 1);
  }

  return windows;
}

function buildReverseCollectionWindows(startDate: string, endDate: string, windowDays: number): CollectionWindow[] {
  const windows: CollectionWindow[] = [];
  const oldest = new Date(`${startDate}T00:00:00Z`);
  let end = new Date(`${endDate}T00:00:00Z`);

  while (end >= oldest) {
    const windowStart = subDays(end, windowDays);
    windows.push({
      start: format(windowStart < oldest ? oldest : windowStart, 'yyyy-MM-dd'),
      end: format(end, 'yyyy-MM-dd'),
    });

    end = addDays(windowStart < oldest ? oldest : windowStart, -1);
  }

  return windows;
}

export function mergeCollectedDates(existingFiles: string[], collectedDates: string[]): string[] {
  const fileSet = new Set(existingFiles);

  for (const date of collectedDates) {
    fileSet.add(`${date}.json`);
  }

  return Array.from(fileSet).sort().reverse();
}

function toCreatedBoundary(value: string, isEnd: boolean): string {
  if (value.includes('T')) {
    return value;
  }

  return `${value}T${isEnd ? '23:59:59' : '00:00:00'}Z`;
}

export function toCreatedRange(window: CollectionWindow): string {
  return `${toCreatedBoundary(window.start, false)}..${toCreatedBoundary(window.end, true)}`;
}

function parseWindowBoundary(value: string): Date {
  return new Date(value.includes('T') ? value : `${value}T00:00:00Z`);
}

export function splitCollectionWindow(window: CollectionWindow): CollectionWindow[] {
  const start = parseWindowBoundary(window.start);
  const end = parseWindowBoundary(window.end);
  const durationMs = end.getTime() - start.getTime();

  if (durationMs <= 60_000) {
    return [];
  }

  const midpoint = new Date(start.getTime() + Math.floor(durationMs / 2));
  const midpointIso = midpoint.toISOString().replace('.000Z', 'Z');

  return [
    {
      start: start.toISOString().replace('.000Z', 'Z'),
      end: midpointIso,
    },
    {
      start: midpointIso,
      end: end.toISOString().replace('.000Z', 'Z'),
    },
  ];
}

const collectionWindows = {
  buildCollectionWindows,
  mergeCollectedDates,
  splitCollectionWindow,
  toCreatedRange,
};

export default collectionWindows;
