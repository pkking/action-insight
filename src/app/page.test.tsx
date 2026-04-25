import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardClient from './DashboardClient';
import type { PullRequestIndexFile } from '@/lib/types';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchPullRequestDetailMock = vi.fn();

function recentIso(hour: number, minute = 0) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - 1);
  value.setUTCHours(hour, minute, 0, 0);
  return value.toISOString();
}

const RECENT_GENERATED_AT = recentIso(0);
const PRIMARY_PR_CREATED_AT = recentIso(1);
const PRIMARY_CI_STARTED_AT = recentIso(1, 5);
const PRIMARY_CI_COMPLETED_AT = recentIso(1, 45);
const PRIMARY_MERGED_AT = recentIso(2, 15);
const SECONDARY_PR_CREATED_AT = recentIso(3);
const SECONDARY_CI_STARTED_AT = recentIso(3, 5);
const SECONDARY_CI_COMPLETED_AT = recentIso(3, 40);
const SECONDARY_MERGED_AT = recentIso(4, 10);
const WORKFLOW_CREATED_AT = recentIso(1, 5);
const WORKFLOW_UPDATED_AT = recentIso(1, 15);
const JOB_CREATED_AT = recentIso(1, 5);
const JOB_STARTED_AT = recentIso(1, 6);
const JOB_COMPLETED_AT = recentIso(1, 15);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/pr-data-fetcher', () => ({
  fetchPullRequestDetail: (...args: unknown[]) => fetchPullRequestDetailMock(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: (props: { children: React.ReactNode; data?: unknown[] }) => <div data-testid="line-chart" data-points={props.data?.length ?? 0}>{props.children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceArea: () => null,
}));

const defaultRepoOptions = [
  { owner: 'vllm-project', repo: 'vllm-ascend', key: 'vllm-project/vllm-ascend' },
  { owner: 'openai', repo: 'action-insight', key: 'openai/action-insight' },
];

function createInitialRepoIndexesByKey(): Record<string, PullRequestIndexFile> {
  return {
    'vllm-project/vllm-ascend': {
      repo: 'vllm-project/vllm-ascend',
      generated_at: RECENT_GENERATED_AT,
      prs: [
        {
          number: 42,
          title: 'Add PR lifecycle dashboard',
          branch: 'feature/pr-metrics',
          author: 'octocat',
          state: 'closed',
          html_url: 'https://github.com/vllm-project/vllm-ascend/pull/42',
          created_at: PRIMARY_PR_CREATED_AT,
          ci_started_at: PRIMARY_CI_STARTED_AT,
          ci_completed_at: PRIMARY_CI_COMPLETED_AT,
          merged_at: PRIMARY_MERGED_AT,
          partialCiHistory: true,
          timeToCiStartInSeconds: 300,
          ciDurationInSeconds: 2400,
          timeToMergeInSeconds: 4500,
          mergeLeadTimeInSeconds: 1800,
          workflowCount: 2,
          successfulWorkflowCount: 1,
          conclusion: 'failure',
        },
      ],
    },
    'openai/action-insight': {
      repo: 'openai/action-insight',
      generated_at: RECENT_GENERATED_AT,
      prs: [
        {
          number: 7,
          title: 'Improve dashboard boot',
          branch: 'feature/boot',
          author: 'robot',
          state: 'closed',
          html_url: 'https://github.com/openai/action-insight/pull/7',
          created_at: SECONDARY_PR_CREATED_AT,
          ci_started_at: SECONDARY_CI_STARTED_AT,
          ci_completed_at: SECONDARY_CI_COMPLETED_AT,
          merged_at: SECONDARY_MERGED_AT,
          partialCiHistory: false,
          timeToCiStartInSeconds: 300,
          ciDurationInSeconds: 2100,
          timeToMergeInSeconds: 4200,
          mergeLeadTimeInSeconds: 1800,
          workflowCount: 1,
          successfulWorkflowCount: 1,
          conclusion: 'success',
        },
      ],
    },
  };
}

function renderDashboard(overrides?: {
  failedRepoKeys?: string[];
  repoIndexesByKey?: Record<string, PullRequestIndexFile>;
  repoOptions?: typeof defaultRepoOptions;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  return render(
    <DashboardClient
      initialFailedRepoKeys={overrides?.failedRepoKeys ?? []}
      initialRepoIndexesByKey={overrides?.repoIndexesByKey ?? createInitialRepoIndexesByKey()}
      initialRepoOptions={overrides?.repoOptions ?? defaultRepoOptions}
      initialSearchParams={overrides?.searchParams}
    />
  );
}

describe('Dashboard PR view', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchPullRequestDetailMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    fetchPullRequestDetailMock.mockResolvedValue({
      repo: 'vllm-project/vllm-ascend',
      generated_at: RECENT_GENERATED_AT,
      pr: {
        number: 42,
        title: 'Add PR lifecycle dashboard',
        branch: 'feature/pr-metrics',
        author: 'octocat',
        state: 'closed',
        html_url: 'https://github.com/vllm-project/vllm-ascend/pull/42',
        created_at: PRIMARY_PR_CREATED_AT,
        ci_started_at: PRIMARY_CI_STARTED_AT,
        ci_completed_at: PRIMARY_CI_COMPLETED_AT,
        merged_at: PRIMARY_MERGED_AT,
        partialCiHistory: true,
        timeToCiStartInSeconds: 300,
        ciDurationInSeconds: 2400,
        timeToMergeInSeconds: 4500,
        mergeLeadTimeInSeconds: 1800,
        workflowCount: 2,
        successfulWorkflowCount: 1,
        conclusion: 'failure',
        workflows: [
          {
            id: 101,
            name: 'lint',
            head_branch: 'feature/pr-metrics',
            status: 'completed',
            conclusion: 'success',
            event: 'pull_request',
            created_at: WORKFLOW_CREATED_AT,
            updated_at: WORKFLOW_UPDATED_AT,
            html_url: 'https://github.com/vllm-project/vllm-ascend/actions/runs/101',
            durationInSeconds: 600,
            pull_requests: [{ number: 42 }],
            jobs: [
              {
                id: 1001,
                name: 'lint-job',
                status: 'completed',
                conclusion: 'success',
                created_at: JOB_CREATED_AT,
                started_at: JOB_STARTED_AT,
                completed_at: JOB_COMPLETED_AT,
                html_url: 'https://github.com/vllm-project/vllm-ascend/actions/jobs/1001',
                queueDurationInSeconds: 60,
                durationInSeconds: 540,
              },
            ],
          },
        ],
      },
    });
  });

  it('defaults to the first available repo from server-provided data', async () => {
    renderDashboard();

    expect(await screen.findByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('repo=openai/action-insight'));

    renderDashboard({
      searchParams: { repo: 'openai/action-insight' },
    });

    expect(await screen.findByDisplayValue('openai/action-insight')).toBeInTheDocument();
  });

  it('shows the repo selector even when rendering the default repo', async () => {
    renderDashboard();

    expect(await screen.findByLabelText('Trend Repo')).toBeInTheDocument();
    expect(screen.getByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();
  });

  it('updates the URL when a different repo is selected', async () => {
    renderDashboard();

    const row = await screen.findByRole('button', { name: /select repo openai\/action-insight/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?repo=openai%2Faction-insight', { scroll: false });
    });
  });

  it('selects a repo when clicking anywhere on the overview row', async () => {
    renderDashboard();

    const row = (await screen.findByRole('button', { name: /select repo openai\/action-insight/i })).closest('tr');
    expect(row).not.toBeNull();

    const cells = within(row!).getAllByRole('cell');
    fireEvent.click(cells[1]);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });
  });

  it('does not show bootstrap loading states when switching repos', async () => {
    renderDashboard();

    await screen.findByText('Repository Overview');

    const row = screen.getByRole('button', { name: /select repo openai\/action-insight/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });

    expect(screen.queryByText('Fetching repository metrics...')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading tracked repositories...')).not.toBeInTheDocument();
  });

  it('debounces filter query updates before syncing them to the URL', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?repo=vllm-project%2Fvllm-ascend', { scroll: false });
    });
    replaceMock.mockClear();

    vi.useFakeTimers();

    try {
      const filterInput = screen.getByPlaceholderText('Filter by PR, title, branch...');
      fireEvent.change(filterInput, { target: { value: 'lint' } });

      expect(replaceMock).not.toHaveBeenCalledWith('/?repo=vllm-project%2Fvllm-ascend&filterName=lint', { scroll: false });

      await act(async () => {
        vi.advanceTimersByTime(249);
      });
      expect(replaceMock).not.toHaveBeenCalledWith('/?repo=vllm-project%2Fvllm-ascend&filterName=lint', { scroll: false });

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(replaceMock).toHaveBeenCalledWith('/?repo=vllm-project%2Fvllm-ascend&filterName=lint', { scroll: false });
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('syncs repo state from the URL on navigation updates', async () => {
    let currentSearchParams = new URLSearchParams('repo=vllm-project/vllm-ascend');
    useSearchParamsMock.mockImplementation(() => currentSearchParams);

    const { rerender } = renderDashboard({
      searchParams: { repo: 'vllm-project/vllm-ascend' },
    });
    expect(await screen.findByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();

    currentSearchParams = new URLSearchParams('repo=openai/action-insight');
    rerender(
      <DashboardClient
        initialFailedRepoKeys={[]}
        initialRepoIndexesByKey={createInitialRepoIndexesByKey()}
        initialRepoOptions={defaultRepoOptions}
        initialSearchParams={{ repo: 'vllm-project/vllm-ascend' }}
      />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });
  });

  it('falls back to the default range when the URL contains an invalid days value', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('days=abc'));

    renderDashboard({
      searchParams: { days: 'abc' },
    });

    expect(await screen.findByRole('button', { name: /last 7 days/i })).toHaveClass('border-blue-200');
    expect(screen.getByRole('button', { name: /last 14 days/i })).not.toHaveClass('border-blue-200');
  });

  it('clears expanded PR details when repo changes from URL navigation', async () => {
    let currentSearchParams = new URLSearchParams('repo=vllm-project/vllm-ascend');
    useSearchParamsMock.mockImplementation(() => currentSearchParams);

    const { rerender } = renderDashboard({
      searchParams: { repo: 'vllm-project/vllm-ascend' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /workflows/i }));
    expect(await screen.findByText('lint')).toBeInTheDocument();

    currentSearchParams = new URLSearchParams('repo=openai/action-insight');
    rerender(
      <DashboardClient
        initialFailedRepoKeys={[]}
        initialRepoIndexesByKey={createInitialRepoIndexesByKey()}
        initialRepoOptions={defaultRepoOptions}
        initialSearchParams={{ repo: 'vllm-project/vllm-ascend' }}
      />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByText('lint')).not.toBeInTheDocument();
      expect(screen.queryByText('Partial CI history')).not.toBeInTheDocument();
    });
  });

  it('shows overview metrics and all trend toggles by default', async () => {
    renderDashboard();

    expect(await screen.findByText('Repository Overview')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /pr e2e p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ci e2e p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pr review p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ci e2e sla/i })).toBeChecked();
  });

  it('loads PR detail on demand and shows workflow rows', async () => {
    renderDashboard();

    const prRow = await screen.findByText('PR #42');
    expect(prRow).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /workflows/i }));

    await waitFor(() => {
      expect(fetchPullRequestDetailMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 42);
    });

    expect(await screen.findByText('lint')).toBeInTheDocument();
    expect(screen.getByText('Partial CI history')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 successful workflows')).toBeInTheDocument();
  });

  it('shows job details after selecting a workflow inside a PR', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: /workflows/i }));
    await screen.findByText('lint');

    const workflowRow = screen
      .getAllByRole('row')
      .find((row: HTMLElement) => within(row).queryByRole('button', { name: /jobs/i }));
    expect(workflowRow).toBeDefined();
    if (!workflowRow) {
      return;
    }
    fireEvent.click(within(workflowRow).getByRole('button', { name: /jobs/i }));

    expect(await screen.findByText('lint-job')).toBeInTheDocument();
  });

  it('shows an empty-state placeholder for repos without computable metrics', async () => {
    renderDashboard({
      repoIndexesByKey: {
        'vllm-project/vllm-ascend': {
          repo: 'vllm-project/vllm-ascend',
          generated_at: RECENT_GENERATED_AT,
          prs: [
            {
              number: 1,
              title: 'Draft only',
              branch: 'draft',
              author: 'octocat',
              state: 'open',
              html_url: 'https://github.com/vllm-project/vllm-ascend/pull/1',
              created_at: PRIMARY_PR_CREATED_AT,
              partialCiHistory: false,
              workflowCount: 0,
              successfulWorkflowCount: 0,
              conclusion: 'unknown',
            },
          ],
        },
        'openai/action-insight': {
          repo: 'openai/action-insight',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
        },
      },
    });

    expect(await screen.findAllByText('Insufficient data')).toHaveLength(8);
  });

  it('explains when the selected repo metrics artifact failed to load', async () => {
    renderDashboard({
      repoIndexesByKey: {
        'openai/action-insight': {
          repo: 'openai/action-insight',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
        },
      },
      failedRepoKeys: ['vllm-project/vllm-ascend'],
    });

    expect(await screen.findAllByText('PR metrics artifact failed to load for this repository.')).toHaveLength(2);
  });

  it('explains when the selected repo metrics artifact has not been generated', async () => {
    renderDashboard({
      repoIndexesByKey: {
        'vllm-project/vllm-ascend': {
          repo: 'vllm-project/vllm-ascend',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
          missingPrArtifact: true,
        },
        'openai/action-insight': {
          repo: 'openai/action-insight',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
        },
      },
    });

    expect(await screen.findAllByText('PR metrics have not been generated for this repository yet.')).toHaveLength(2);
  });

  it('shows partial PR resolution metadata for high-volume repos', async () => {
    renderDashboard({
      repoIndexesByKey: {
        'vllm-project/vllm-ascend': {
          repo: 'vllm-project/vllm-ascend',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
          partialPrResolution: true,
          resolvedPrShaCount: 25,
          unresolvedPrShaCount: 100,
          skippedPrShaCount: 100,
        },
        'openai/action-insight': {
          repo: 'openai/action-insight',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
        },
      },
    });

    expect(await screen.findByText(/Partial PR resolution for vllm-project\/vllm-ascend: 25 SHA/)).toBeInTheDocument();
    expect(screen.getAllByText('PR metrics are partially resolved for this repository. More PRs may appear after future ETL runs.')).toHaveLength(2);
  });
});
