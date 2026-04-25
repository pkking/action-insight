import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from './page';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchPullRequestIndexMock = vi.fn();
const fetchPullRequestDetailMock = vi.fn();
const fetchPullRequestIndexesMock = vi.fn();
const fetchMock = vi.fn();

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

global.fetch = fetchMock as typeof fetch;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/pr-data-fetcher', () => ({
  fetchPullRequestIndex: (...args: unknown[]) => fetchPullRequestIndexMock(...args),
  fetchPullRequestDetail: (...args: unknown[]) => fetchPullRequestDetailMock(...args),
  fetchPullRequestIndexes: (...args: unknown[]) => fetchPullRequestIndexesMock(...args),
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

describe('Dashboard PR view', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchMock.mockReset();
    fetchPullRequestIndexMock.mockReset();
    fetchPullRequestDetailMock.mockReset();
    fetchPullRequestIndexesMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        repos: [
          { owner: 'vllm-project', repo: 'vllm-ascend', key: 'vllm-project/vllm-ascend' },
          { owner: 'openai', repo: 'action-insight', key: 'openai/action-insight' },
        ],
      }),
    } as Response);
    fetchPullRequestIndexesMock.mockResolvedValue({
      indexesByRepoKey: {
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
      },
      failedRepoKeys: [],
    });
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

  it('defaults to the first available repo and fetches its PR index', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchPullRequestIndexesMock).toHaveBeenCalledWith([
        { owner: 'vllm-project', repo: 'vllm-ascend', key: 'vllm-project/vllm-ascend' },
        { owner: 'openai', repo: 'action-insight', key: 'openai/action-insight' },
      ]);
    });
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('repo=openai/action-insight'));

    render(<Dashboard />);

    expect(await screen.findByDisplayValue('openai/action-insight')).toBeInTheDocument();
  });

  it('shows the repo selector even when rendering the default repo', async () => {
    render(<Dashboard />);

    expect(await screen.findByLabelText('Trend Repo')).toBeInTheDocument();
    expect(screen.getByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();
  });

  it('updates the URL when a different repo is selected', async () => {
    render(<Dashboard />);

    const row = await screen.findByRole('button', { name: /select repo openai\/action-insight/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?repo=openai%2Faction-insight', { scroll: false });
    });
  });

  it('selects a repo when clicking anywhere on the overview row', async () => {
    render(<Dashboard />);

    const row = (await screen.findByRole('button', { name: /select repo openai\/action-insight/i })).closest('tr');
    expect(row).not.toBeNull();

    const cells = within(row!).getAllByRole('cell');
    fireEvent.click(cells[1]);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });
  });

  it('does not refetch repositories or show the bootstrap loading state when switching repos', async () => {
    render(<Dashboard />);

    await screen.findByText('Repository Overview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchPullRequestIndexesMock).toHaveBeenCalledTimes(1);

    const row = screen.getByRole('button', { name: /select repo openai\/action-insight/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchPullRequestIndexesMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Fetching repository metrics...')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading tracked repositories...')).not.toBeInTheDocument();
  });

  it('syncs repo state from the URL on navigation updates', async () => {
    let currentSearchParams = new URLSearchParams('repo=vllm-project/vllm-ascend');
    useSearchParamsMock.mockImplementation(() => currentSearchParams);

    const { rerender } = render(<Dashboard />);
    expect(await screen.findByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();

    currentSearchParams = new URLSearchParams('repo=openai/action-insight');
    rerender(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });
  });

  it('falls back to the default range when the URL contains an invalid days value', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('days=abc'));

    render(<Dashboard />);

    expect(await screen.findByRole('button', { name: /last 7 days/i })).toHaveClass('border-blue-200');
    expect(screen.getByRole('button', { name: /last 14 days/i })).not.toHaveClass('border-blue-200');
  });

  it('clears expanded PR details when repo changes from URL navigation', async () => {
    let currentSearchParams = new URLSearchParams('repo=vllm-project/vllm-ascend');
    useSearchParamsMock.mockImplementation(() => currentSearchParams);

    const { rerender } = render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /workflows/i }));
    expect(await screen.findByText('lint')).toBeInTheDocument();

    currentSearchParams = new URLSearchParams('repo=openai/action-insight');
    rerender(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('openai/action-insight')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByText('lint')).not.toBeInTheDocument();
      expect(screen.queryByText('Partial CI history')).not.toBeInTheDocument();
    });
  });

  it('shows overview metrics and all trend toggles by default', async () => {
    render(<Dashboard />);

    expect(await screen.findByText('Repository Overview')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /pr e2e p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ci e2e p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pr review p90/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ci e2e sla/i })).toBeChecked();
  });

  it('loads PR detail on demand and shows workflow rows', async () => {
    render(<Dashboard />);

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
    render(<Dashboard />);

    fireEvent.click(await screen.findByRole('button', { name: /workflows/i }));
    await screen.findByText('lint');

    const workflowRow = screen.getAllByRole('row').find((row) => within(row).queryByRole('button', { name: /jobs/i }))!;
    fireEvent.click(within(workflowRow).getByRole('button', { name: /jobs/i }));

    expect(await screen.findByText('lint-job')).toBeInTheDocument();
  });

  it('shows an empty-state placeholder for repos without computable metrics', async () => {
    fetchPullRequestIndexesMock.mockResolvedValueOnce({
      indexesByRepoKey: {
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
      failedRepoKeys: [],
    });

    render(<Dashboard />);

    expect(await screen.findAllByText('Insufficient data')).toHaveLength(8);
  });

  it('explains when the selected repo metrics artifact failed to load', async () => {
    fetchPullRequestIndexesMock.mockResolvedValueOnce({
      indexesByRepoKey: {
        'openai/action-insight': {
          repo: 'openai/action-insight',
          generated_at: RECENT_GENERATED_AT,
          prs: [],
        },
      },
      failedRepoKeys: ['vllm-project/vllm-ascend'],
    });

    render(<Dashboard />);

    expect(await screen.findAllByText('PR metrics artifact failed to load for this repository.')).toHaveLength(2);
  });

  it('explains when the selected repo metrics artifact has not been generated', async () => {
    fetchPullRequestIndexesMock.mockResolvedValueOnce({
      indexesByRepoKey: {
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
      failedRepoKeys: [],
    });

    render(<Dashboard />);

    expect(await screen.findAllByText('PR metrics have not been generated for this repository yet.')).toHaveLength(2);
  });

  it('shows partial PR resolution metadata for high-volume repos', async () => {
    fetchPullRequestIndexesMock.mockResolvedValueOnce({
      indexesByRepoKey: {
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
      failedRepoKeys: [],
    });

    render(<Dashboard />);

    expect(await screen.findByText(/Partial PR resolution for vllm-project\/vllm-ascend: 25 SHA/)).toBeInTheDocument();
    expect(screen.getAllByText('PR metrics are partially resolved for this repository. More PRs may appear after future ETL runs.')).toHaveLength(2);
  });
});
