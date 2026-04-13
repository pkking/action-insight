import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from './page';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchRunsMock = vi.fn();
const fetchMock = vi.fn();

let lastLineChartProps: Record<string, unknown> | null = null;

global.fetch = fetchMock as typeof fetch;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/data-fetcher', () => ({
  fetchRuns: (...args: unknown[]) => fetchRunsMock(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: (props: { children: React.ReactNode; data?: unknown[] }) => {
    lastLineChartProps = props;
    return <div data-testid="line-chart" data-points={props.data?.length ?? 0}>{props.children}</div>;
  },
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceArea: () => null,
}));

describe('Dashboard repo selection', () => {
  beforeEach(() => {
    lastLineChartProps = null;
    replaceMock.mockReset();
    fetchRunsMock.mockReset();
    fetchMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    fetchRunsMock.mockResolvedValue([]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        repos: [
          { owner: 'vllm-project', repo: 'vllm-ascend', key: 'vllm-project/vllm-ascend' },
          { owner: 'openai', repo: 'action-insight', key: 'openai/action-insight' },
        ],
      }),
    } as Response);
  });

  it('defaults to the first available repo and fetches it', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', {
        days: 7,
        startDate: undefined,
        endDate: undefined,
      });
    });
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('repo=openai/action-insight'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('openai', 'action-insight', {
        days: 7,
        startDate: undefined,
        endDate: undefined,
      });
    });
  });

  it('falls back when the URL repo is invalid', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('repo=bad/input'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', {
        days: 7,
        startDate: undefined,
        endDate: undefined,
      });
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

  it('passes the selected custom date range to fetchRuns', async () => {
    const { container } = render(<Dashboard />);

    const customButton = await screen.findByRole('button', { name: /custom/i });
    fireEvent.click(customButton);

    const dateInputs = container.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-04-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-04-10' } });

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenLastCalledWith('vllm-project', 'vllm-ascend', {
        days: 7,
        startDate: '2026-04-01',
        endDate: '2026-04-10',
      });
    });
  });
});
