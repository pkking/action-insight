import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from './page';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchPullRequestIndexMock = vi.fn();
const fetchPullRequestDetailMock = vi.fn();
const fetchMock = vi.fn();

global.fetch = fetchMock as typeof fetch;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/pr-data-fetcher', () => ({
  fetchPullRequestIndex: (...args: unknown[]) => fetchPullRequestIndexMock(...args),
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
  ReferenceArea: () => null,
}));

describe('Dashboard PR view', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchMock.mockReset();
    fetchPullRequestIndexMock.mockReset();
    fetchPullRequestDetailMock.mockReset();
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
    fetchPullRequestIndexMock.mockResolvedValue({
      repo: 'vllm-project/vllm-ascend',
      generated_at: '2026-04-18T00:00:00Z',
      prs: [
        {
          number: 42,
          title: 'Add PR lifecycle dashboard',
          branch: 'feature/pr-metrics',
          author: 'octocat',
          state: 'closed',
          html_url: 'https://github.com/vllm-project/vllm-ascend/pull/42',
          created_at: '2026-04-18T01:00:00Z',
          ci_started_at: '2026-04-18T01:05:00Z',
          ci_completed_at: '2026-04-18T01:45:00Z',
          merged_at: '2026-04-18T02:15:00Z',
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
    });
    fetchPullRequestDetailMock.mockResolvedValue({
      repo: 'vllm-project/vllm-ascend',
      generated_at: '2026-04-18T00:00:00Z',
      pr: {
        number: 42,
        title: 'Add PR lifecycle dashboard',
        branch: 'feature/pr-metrics',
        author: 'octocat',
        state: 'closed',
        html_url: 'https://github.com/vllm-project/vllm-ascend/pull/42',
        created_at: '2026-04-18T01:00:00Z',
        ci_started_at: '2026-04-18T01:05:00Z',
        ci_completed_at: '2026-04-18T01:45:00Z',
        merged_at: '2026-04-18T02:15:00Z',
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
            created_at: '2026-04-18T01:05:00Z',
            updated_at: '2026-04-18T01:15:00Z',
            html_url: 'https://github.com/vllm-project/vllm-ascend/actions/runs/101',
            durationInSeconds: 600,
            pull_requests: [{ number: 42 }],
            jobs: [
              {
                id: 1001,
                name: 'lint-job',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-04-18T01:05:00Z',
                started_at: '2026-04-18T01:06:00Z',
                completed_at: '2026-04-18T01:15:00Z',
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
      expect(fetchPullRequestIndexMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend');
    });
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('repo=openai/action-insight'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchPullRequestIndexMock).toHaveBeenCalledWith('openai', 'action-insight');
    });
  });

  it('shows the repo selector even when rendering the default repo', async () => {
    render(<Dashboard />);

    expect(await screen.findByLabelText('Repo')).toBeInTheDocument();
    expect(screen.getByDisplayValue('vllm-project/vllm-ascend')).toBeInTheDocument();
  });

  it('updates the URL when a different repo is selected', async () => {
    render(<Dashboard />);

    const select = await screen.findByLabelText('Repo');
    fireEvent.change(select, { target: { value: 'openai/action-insight' } });

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?repo=openai%2Faction-insight', { scroll: false });
    });
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
});
