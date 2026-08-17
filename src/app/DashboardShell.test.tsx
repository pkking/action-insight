import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardShell from './DashboardShell';
import type {
  CostDashboardResult,
  PrDashboardResult,
  WorkflowDashboardResult,
} from '@/lib/dashboard-read-model';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ data }: { data?: unknown[] }) => <div data-testid="chart" data-len={data?.length ?? 0} />,
  LineChart: ({ data }: { data?: unknown[] }) => <div data-testid="cost-chart" data-len={data?.length ?? 0} />,
  Bar: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const repoOptions = [{ owner: 'owner', repo: 'repo', key: 'owner/repo' }];

function emptyResult(): PrDashboardResult {
  return {
    tab: 'pr',
    cards: {
      endToEnd: { avg: 0, p50: 0, p90: 0, sampleCount: 0 },
      ciRuntime: { avg: 0, p50: 0, p90: 0, sampleCount: 0 },
      review: { avg: 0, p50: 0, p90: 0, sampleCount: 0 },
      forcedMergeRate: 0,
      mergedPrCount: 0,
      eligibleForcedMergeCount: 0,
    },
    series: [],
    rows: [],
    page: 1,
    pageSize: 20,
    totalRows: 0,
    displayedObservationCount: 0,
    truncated: false,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples: 0,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

function rowResult(): PrDashboardResult {
  return {
    ...emptyResult(),
    cards: {
      endToEnd: { avg: 4400, p50: 4400, p90: 4400, sampleCount: 1 },
      ciRuntime: { avg: 3000, p50: 3000, p90: 3000, sampleCount: 1 },
      review: { avg: 1400, p50: 1400, p90: 1400, sampleCount: 1 },
      forcedMergeRate: 0,
      mergedPrCount: 1,
      eligibleForcedMergeCount: 1,
    },
    series: [
      { date: '2026-01-01', prNumber: 42, repoKey: 'owner/repo', queue: 600, ciRuntime: 3000, review: 1400 },
    ],
    rows: [
      {
        repoKey: 'owner/repo',
        prNumber: 42,
        title: 'Add dashboard',
        htmlUrl: 'https://github.com/owner/repo/pull/42',
        queue: 600,
        ciRuntime: 3000,
        review: 1400,
        mergedAt: '2026-01-01T02:00:00Z',
        mergeState: 'closed',
        forcedMerge: false,
        partialCiHistory: false,
      },
    ],
    totalRows: 1,
    displayedObservationCount: 1,
  };
}

function emptyCostResult(): CostDashboardResult {
  return {
    tab: 'cost',
    cards: {
      totalMachineHours: 0,
      dailyAverageMachineHours: 0,
      contributingCount: 0,
    },
    series: [],
    rows: [],
    page: 1,
    pageSize: 20,
    totalRows: 0,
    displayedObservationCount: 0,
    truncated: false,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples: 0,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

function costResult(): CostDashboardResult {
  return {
    ...emptyCostResult(),
    cards: {
      totalMachineHours: 8,
      machineHoursPerMergedPr: 4,
      topRepo: { repoKey: 'owner/repo', machineHours: 8 },
      dailyAverageMachineHours: 0.57,
      contributingCount: 2,
    },
    series: [
      { date: '2026-01-01', repoKey: 'owner/repo', machineHours: 4 },
      { date: '2026-01-02', repoKey: 'owner/repo', machineHours: 4 },
    ],
    rows: [
      {
        repoKey: 'owner/repo',
        workflowFile: 'ci.yml',
        workflowRef: 'refs/heads/main',
        resourceModel: 'npu-a3',
        avgWorkflowTotalDuration: 3600,
        attemptCount: 2,
        successCount: 1,
        failureRate: 50,
        machineHours: 8,
        shareOfTotal: 100,
        unknownCostCount: 0,
      },
    ],
    totalRows: 1,
    displayedObservationCount: 1,
  };
}

const originalFetch = global.fetch;

function emptyWorkflowResult(): WorkflowDashboardResult {
  return {
    tab: 'workflow',
    cards: {
      totalAttempts: 0,
      successRate: 0,
      contributingRepoCount: 0,
    },
    series: [],
    rows: [],
    page: 1,
    pageSize: 20,
    totalRows: 0,
    displayedObservationCount: 0,
    truncated: false,
    quality: {
      invalidTimingSamples: 0,
      unknownResourceSamples: 0,
      partialHistorySamples: 0,
      legacyFallbackSamples: 0,
    },
  };
}

function workflowResult(): WorkflowDashboardResult {
  return {
    ...emptyWorkflowResult(),
    cards: {
      totalAttempts: 5,
      p50TotalDuration: 3600,
      p90TotalDuration: 5400,
      successRate: 60,
      contributingRepoCount: 1,
    },
    series: [
      { date: '2026-01-01', key: 'owner/repo', attempts: 3 },
      { date: '2026-01-02', key: 'owner/repo', attempts: 2 },
    ],
    rows: [
      {
        repoKey: 'owner/repo',
        workflowFile: 'ci.yml',
        workflowRef: 'refs/heads/main',
        resourceModel: 'npu-a3',
        avgWorkflowTotalDuration: 3600,
        attemptCount: 5,
        successCount: 3,
        failureRate: 40,
        machineHours: 8,
        unknownCostCount: 0,
        latestDate: '2026-01-02',
      },
    ],
    totalRows: 1,
    displayedObservationCount: 1,
  };
}


function mockFetchDetail(jobs: unknown[] = []) {
  vi.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    if (url === '/api/data' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      if (body.action === 'fetchPullRequestDetail') {
        return new Response(
          JSON.stringify({
            data: {
              pr: {
                number: 42,
                title: 'Add dashboard',
                branch: 'main',
                author: 'octocat',
                state: 'closed',
                html_url: 'https://github.com/owner/repo/pull/42',
                created_at: '2026-01-01T00:00:00Z',
                ci_started_at: '2026-01-01T00:10:00Z',
                ci_completed_at: '2026-01-01T01:00:00Z',
                merged_at: '2026-01-01T02:00:00Z',
                partialCiHistory: false,
                timeToCiStartInSeconds: 600,
                ciDurationInSeconds: 3000,
                mergeLeadTimeInSeconds: 1400,
                workflowCount: 1,
                successfulWorkflowCount: 1,
                conclusion: 'success',
                workflows: [
                  {
                    id: 100,
                    runAttempt: 1,
                    name: 'ci.yml',
                    head_branch: 'main',
                    status: 'completed',
                    conclusion: 'success',
                    event: 'pull_request',
                    created_at: '2026-01-01T00:10:00Z',
                    updated_at: '2026-01-01T01:00:00Z',
                    html_url: 'https://github.com/owner/repo/actions/runs/100',
                    durationInSeconds: 3000,
                    jobs,
                  },
                ],
              },
            },
          }),
        );
      }
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

beforeEach(() => {
  replaceMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe('DashboardShell', () => {
  it('renders the empty state when there are no merged PRs', () => {
    render(<DashboardShell repoOptions={repoOptions} result={emptyResult()} searchParams={{}} />);
    expect(screen.getByText(/No merged PRs in the selected range/i)).toBeInTheDocument();
    // Card label + table heading both say “Merged PRs”.
    expect(screen.getAllByText('Merged PRs').length).toBeGreaterThanOrEqual(1);
  });

  it('renders PR rows and the chart from the read-model result', () => {
    render(<DashboardShell repoOptions={repoOptions} result={rowResult()} searchParams={{}} />);
    // PR link rendered
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Add dashboard')).toBeInTheDocument();
    // Chart received the series point
    expect(screen.getByTestId('chart').getAttribute('data-len')).toBe('1');
  });

  it('lazily fetches PR drill-down on row click and renders the Machine-Hours summary', async () => {
    mockFetchDetail([
      {
        id: 200,
        runAttempt: 1,
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-01-01T00:10:00Z',
        started_at: '2026-01-01T00:12:00Z',
        completed_at: '2026-01-01T00:42:00Z',
        html_url: 'https://github.com/owner/repo/jobs/200',
        queueDurationInSeconds: 120,
        durationInSeconds: 1800,
        runtimeInSeconds: 1800,
        resource_model: 'npu-a3',
        resource_count: 4,
        steps: [],
      },
    ]);

    render(<DashboardShell repoOptions={repoOptions} result={rowResult()} searchParams={{}} />);

    // Before click: no drill-down content.
    expect(screen.queryByText(/Machine-Hours by Resource Model/i)).not.toBeInTheDocument();

    // Click the PR title cell (not the <a>, which stops propagation) to trigger the row's lazy fetch.
    await act(async () => {
      fireEvent.click(screen.getByText('Add dashboard'));
    });

    // Loading state, then drill-down with resource summary + job.
    await waitFor(() => {
      expect(screen.getByText(/Machine-Hours by Resource Model/i)).toBeInTheDocument();
    });
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.getByText('npu-a3')).toBeInTheDocument();
  });

  it('renders truncation notice when observations exceed the cap', () => {
    const truncated = {
      ...rowResult(),
      displayedObservationCount: 500,
      truncated: true,
      cards: { ...rowResult().cards, mergedPrCount: 600 },
    };
    render(<DashboardShell repoOptions={repoOptions} result={truncated} searchParams={{}} />);
    expect(screen.getByText(/Showing latest 500 of 600 observations/i)).toBeInTheDocument();
  });

  it('renders the Cost tab cards, chart, and table from the read-model result', () => {
    render(<DashboardShell repoOptions={repoOptions} result={costResult()} searchParams={{}} />);
    // Total card + table row render.
    expect(screen.getByText('Total Machine-Hours')).toBeInTheDocument();
    expect(screen.getByText('ci.yml')).toBeInTheDocument();
    expect(screen.getByText('npu-a3')).toBeInTheDocument();
    // Daily chart received the two series points.
    expect(screen.getByTestId('cost-chart').getAttribute('data-len')).toBe('2');
  });

  it('renders the Cost empty state when there are no attributable jobs', () => {
    render(<DashboardShell repoOptions={repoOptions} result={emptyCostResult()} searchParams={{}} />);
    expect(screen.getByText(/No tracked workflow jobs in range/i)).toBeInTheDocument();
    expect(screen.getByText(/No attributable jobs in the selected range/i)).toBeInTheDocument();
  });

  it('renders the Workflow tab cards, chart, and grouped table', () => {
    render(<DashboardShell repoOptions={repoOptions} result={workflowResult()} searchParams={{}} />);
    expect(screen.getByText('Total Attempts')).toBeInTheDocument();
    expect(screen.getByText('ci.yml')).toBeInTheDocument();
    expect(screen.getByTestId('cost-chart').getAttribute('data-len')).toBe('2');
  });

  it('renders the Workflow empty state', () => {
    render(<DashboardShell repoOptions={repoOptions} result={emptyWorkflowResult()} searchParams={{}} />);
    expect(screen.getByText(/No tracked workflow attempts in range/i)).toBeInTheDocument();
    expect(screen.getByText(/No tracked attempts in the selected range/i)).toBeInTheDocument();
  });
});
