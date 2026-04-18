import { describe, expect, it } from 'vitest';

import type { PullRequestMetricsSummary } from './types';
import {
  buildDailyTrend,
  buildRepoOverviewRows,
  createDateRange,
} from './overview-metrics';

function buildPr(overrides: Partial<PullRequestMetricsSummary>): PullRequestMetricsSummary {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? 'PR',
    branch: overrides.branch ?? 'feature/test',
    author: overrides.author ?? 'octocat',
    state: overrides.state ?? 'closed',
    html_url: overrides.html_url ?? 'https://example.com/pr/1',
    created_at: overrides.created_at ?? '2026-04-10T00:00:00Z',
    ci_started_at: overrides.ci_started_at,
    ci_completed_at: overrides.ci_completed_at,
    merged_at: overrides.merged_at,
    partialCiHistory: overrides.partialCiHistory ?? false,
    timeToCiStartInSeconds: overrides.timeToCiStartInSeconds,
    ciDurationInSeconds: overrides.ciDurationInSeconds,
    timeToMergeInSeconds: overrides.timeToMergeInSeconds,
    mergeLeadTimeInSeconds: overrides.mergeLeadTimeInSeconds,
    workflowCount: overrides.workflowCount ?? 1,
    successfulWorkflowCount: overrides.successfulWorkflowCount ?? 1,
    conclusion: overrides.conclusion ?? 'success',
  };
}

describe('overview-metrics', () => {
  it('builds repo overview rows with P90 minute metrics and SLA rate', () => {
    const range = createDateRange({ startDate: '2026-04-01', endDate: '2026-04-30' });
    const rows = buildRepoOverviewRows(
      [
        {
          repoKey: 'alpha/core',
          prs: [
            buildPr({
              number: 1,
              created_at: '2026-04-10T08:00:00Z',
              merged_at: '2026-04-10T09:30:00Z',
              timeToMergeInSeconds: 90 * 60,
              ci_started_at: '2026-04-10T08:05:00Z',
              ci_completed_at: '2026-04-10T08:35:00Z',
              ciDurationInSeconds: 30 * 60,
              mergeLeadTimeInSeconds: 55 * 60,
            }),
            buildPr({
              number: 2,
              created_at: '2026-04-12T08:00:00Z',
              merged_at: '2026-04-12T10:00:00Z',
              timeToMergeInSeconds: 120 * 60,
              ci_started_at: '2026-04-12T08:10:00Z',
              ci_completed_at: '2026-04-12T08:55:00Z',
              ciDurationInSeconds: 45 * 60,
              mergeLeadTimeInSeconds: 65 * 60,
            }),
          ],
        },
      ],
      range
    );

    expect(rows).toEqual([
      expect.objectContaining({
        repoKey: 'alpha/core',
        sampleCount: 2,
        prE2EP90Minutes: 120,
        ciE2EP90Minutes: 45,
        reviewP90Minutes: 65,
        ciE2ESlaRate: 100,
      }),
    ]);
  });

  it('filters out PRs outside the selected date range', () => {
    const range = createDateRange({ startDate: '2026-04-10', endDate: '2026-04-10' });
    const rows = buildRepoOverviewRows(
      [
        {
          repoKey: 'alpha/core',
          prs: [
            buildPr({
              number: 1,
              created_at: '2026-04-10T08:00:00Z',
              merged_at: '2026-04-10T09:30:00Z',
              timeToMergeInSeconds: 90 * 60,
              ciDurationInSeconds: 30 * 60,
              mergeLeadTimeInSeconds: 20 * 60,
            }),
            buildPr({
              number: 2,
              created_at: '2026-04-11T08:00:00Z',
              merged_at: '2026-04-11T09:30:00Z',
              timeToMergeInSeconds: 999 * 60,
              ciDurationInSeconds: 999 * 60,
              mergeLeadTimeInSeconds: 999 * 60,
            }),
          ],
        },
      ],
      range
    );

    expect(rows[0]).toEqual(
      expect.objectContaining({
        sampleCount: 1,
        prE2EP90Minutes: 90,
        ciE2EP90Minutes: 30,
        reviewP90Minutes: 20,
      })
    );
  });

  it('returns null metrics for repositories without computable samples', () => {
    const range = createDateRange({ startDate: '2026-04-01', endDate: '2026-04-30' });
    const rows = buildRepoOverviewRows(
      [
        {
          repoKey: 'alpha/core',
          prs: [
            buildPr({
              number: 1,
              created_at: '2026-04-10T08:00:00Z',
              merged_at: undefined,
              timeToMergeInSeconds: undefined,
              ciDurationInSeconds: undefined,
              mergeLeadTimeInSeconds: undefined,
            }),
          ],
        },
      ],
      range
    );

    expect(rows).toEqual([
      expect.objectContaining({
        repoKey: 'alpha/core',
        sampleCount: 1,
        prE2EP90Minutes: null,
        ciE2EP90Minutes: null,
        reviewP90Minutes: null,
        ciE2ESlaRate: null,
      }),
    ]);
  });

  it('builds daily trend points with only computable metrics per day', () => {
    const range = createDateRange({ startDate: '2026-04-01', endDate: '2026-04-30' });
    const points = buildDailyTrend(
      [
        buildPr({
          number: 1,
          created_at: '2026-04-10T08:00:00Z',
          merged_at: '2026-04-10T09:30:00Z',
          timeToMergeInSeconds: 90 * 60,
          ciDurationInSeconds: 30 * 60,
          mergeLeadTimeInSeconds: 60 * 60,
        }),
        buildPr({
          number: 2,
          created_at: '2026-04-10T12:00:00Z',
          merged_at: '2026-04-10T13:45:00Z',
          timeToMergeInSeconds: 105 * 60,
          ciDurationInSeconds: 70 * 60,
          mergeLeadTimeInSeconds: 35 * 60,
        }),
        buildPr({
          number: 3,
          created_at: '2026-04-11T09:00:00Z',
          merged_at: undefined,
          timeToMergeInSeconds: undefined,
          ciDurationInSeconds: 40 * 60,
          mergeLeadTimeInSeconds: undefined,
        }),
      ],
      range
    );

    expect(points).toEqual([
      expect.objectContaining({
        date: '2026-04-10',
        prE2EP90Minutes: 105,
        ciE2EP90Minutes: 70,
        reviewP90Minutes: 60,
        ciE2ESlaRate: 50,
      }),
      expect.objectContaining({
        date: '2026-04-11',
        prE2EP90Minutes: null,
        ciE2EP90Minutes: 40,
        reviewP90Minutes: null,
        ciE2ESlaRate: 100,
      }),
    ]);
  });
});
