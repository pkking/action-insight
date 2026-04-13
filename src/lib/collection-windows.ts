import { format, subDays } from 'date-fns';

export interface CollectionWindow {
  start: string;
  end: string;
}

interface BuildCollectionWindowsOptions {
  latest: string;
  retentionDays: number;
  now?: Date;
  windowDays?: number;
  forceFullBackfill?: boolean;
}

const DEFAULT_WINDOW_DAYS = 7;

export function buildCollectionWindows({
  latest,
  retentionDays,
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  forceFullBackfill = false,
}: BuildCollectionWindowsOptions): CollectionWindow[] {
  if (latest && !forceFullBackfill) {
    return [{ start: latest, end: format(now, 'yyyy-MM-dd') }];
  }

  const windows: CollectionWindow[] = [];
  let end = now;
  const oldest = subDays(now, retentionDays);

  while (end > oldest) {
    const start = subDays(end, windowDays);
    const boundedStart = start > oldest ? start : oldest;

    windows.push({
      start: format(boundedStart, 'yyyy-MM-dd'),
      end: format(end, 'yyyy-MM-dd'),
    });

    end = boundedStart;
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
};

export default collectionWindows;
