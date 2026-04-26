import { endOfDay, format, isAfter, isBefore, parseISO, startOfDay, subDays } from 'date-fns';

import type { DailyTrendPoint, DateRange, PullRequestMetricsSummary, RepoOverviewRow } from './types';

interface CreateDateRangeOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  now?: Date;
}

interface RepoOverviewInput {
  repoKey: string;
  prs: PullRequestMetricsSummary[];
}

function roundMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

function percentile(values: number[], value: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return sorted[index];
}

export function filterByDateRange<T extends { created_at: string }>(items: T[], range: DateRange): T[] {
  return items.filter((item) => {
    const createdAt = new Date(item.created_at);
    return !isBefore(createdAt, range.start) && !isAfter(createdAt, range.end);
  });
}

function toMinutesOrNull(values: Array<number | undefined>): number | null {
  const valid = values.filter((value): value is number => value !== undefined);
  const result = percentile(valid, 0.9);
  return result === null ? null : roundMinutes(result);
}

function toRateOrNull(values: Array<number | undefined>): number | null {
  const valid = values.filter((value): value is number => value !== undefined);
  if (valid.length === 0) {
    return null;
  }

  const met = valid.filter((value) => value <= 60 * 60).length;
  return Math.round((met / valid.length) * 100);
}

function toDailyPoint(date: string, prs: PullRequestMetricsSummary[]): DailyTrendPoint {
  return {
    date,
    label: format(parseISO(date), 'MMM dd'),
    sampleCount: prs.length,
    prE2EP90Minutes: toMinutesOrNull(prs.map((pr) => pr.timeToMergeInSeconds)),
    ciE2EP90Minutes: toMinutesOrNull(prs.map((pr) => pr.ciDurationInSeconds)),
    reviewP90Minutes: toMinutesOrNull(prs.map((pr) => pr.mergeLeadTimeInSeconds)),
    ciE2ESlaRate: toRateOrNull(prs.map((pr) => pr.ciDurationInSeconds)),
  };
}

export function createDateRange({
  days = 7,
  startDate,
  endDate,
  now = new Date(),
}: CreateDateRangeOptions): DateRange {
  if (startDate && endDate) {
    return {
      start: startOfDay(parseISO(startDate)),
      end: endOfDay(parseISO(endDate)),
    };
  }

  return {
    start: startOfDay(subDays(now, Math.max(days - 1, 0))),
    end: endOfDay(now),
  };
}

export function buildRepoOverviewRows(entries: RepoOverviewInput[], range: DateRange): RepoOverviewRow[] {
  return entries
    .map(({ repoKey, prs }) => {
      const filtered = filterByDateRange(prs, range);

      return {
        repoKey,
        totalPrs: filtered.length,
        sampleCount: filtered.length,
        prE2EP90Minutes: toMinutesOrNull(filtered.map((pr) => pr.timeToMergeInSeconds)),
        ciE2EP90Minutes: toMinutesOrNull(filtered.map((pr) => pr.ciDurationInSeconds)),
        reviewP90Minutes: toMinutesOrNull(filtered.map((pr) => pr.mergeLeadTimeInSeconds)),
        ciE2ESlaRate: toRateOrNull(filtered.map((pr) => pr.ciDurationInSeconds)),
      };
    })
    .sort((left, right) => left.repoKey.localeCompare(right.repoKey));
}

export function buildDailyTrend(prs: PullRequestMetricsSummary[], range: DateRange): DailyTrendPoint[] {
  const grouped = new Map<string, PullRequestMetricsSummary[]>();

  for (const pr of filterByDateRange(prs, range)) {
    const date = pr.created_at.slice(0, 10);
    const existing = grouped.get(date) ?? [];
    existing.push(pr);
    grouped.set(date, existing);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, datePrs]) => toDailyPoint(date, datePrs));
}
