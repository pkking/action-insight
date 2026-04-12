import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from './page';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchRunsMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/data-fetcher', () => ({
  fetchRuns: (...args: unknown[]) => fetchRunsMock(...args),
}));

vi.mock('@/lib/available-repos', () => ({
  AVAILABLE_REPOS: [
    {
      owner: 'vllm-project',
      repo: 'vllm-ascend',
      slug: 'vllm-project/vllm-ascend',
      label: 'vllm-project/vllm-ascend',
    },
    {
      owner: 'openai',
      repo: 'action-insight',
      slug: 'openai/action-insight',
      label: 'openai/action-insight',
    },
  ],
  DEFAULT_AVAILABLE_REPO: {
    owner: 'vllm-project',
    repo: 'vllm-ascend',
    slug: 'vllm-project/vllm-ascend',
    label: 'vllm-project/vllm-ascend',
  },
  findAvailableRepo: (owner: string | null, repo: string | null) => {
    if (owner === 'vllm-project' && repo === 'vllm-ascend') {
      return {
        owner,
        repo,
        slug: 'vllm-project/vllm-ascend',
        label: 'vllm-project/vllm-ascend',
      };
    }

    if (owner === 'openai' && repo === 'action-insight') {
      return {
        owner,
        repo,
        slug: 'openai/action-insight',
        label: 'openai/action-insight',
      };
    }

    return null;
  },
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceArea: () => null,
}));

describe('Dashboard repo selection', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchRunsMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    fetchRunsMock.mockResolvedValue([]);
  });

  it('defaults to the first available repo and fetches it', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 7);
    });
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('owner=openai&repo=action-insight'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('openai', 'action-insight', 7);
    });
  });

  it('falls back when the URL repo is invalid', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('owner=bad&repo=input'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 7);
    });
  });

  it('shows the selection panel even when rendering the default repo', async () => {
    render(<Dashboard />);

    expect(await screen.findByText('Tracked Repositories')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'vllm-project/vllm-ascend' })).toBeInTheDocument();
  });

  it('updates the URL when a different repo is selected', async () => {
    render(<Dashboard />);

    const button = await screen.findByRole('button', { name: 'openai/action-insight' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/?owner=openai&repo=action-insight', { scroll: false });
    });
  });
});
