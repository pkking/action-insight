import fixture from '../../tests/fixtures/attempt-timing-40h.json';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CiCycleGantt } from './CiCycleGantt';
import { groupRunsIntoCycles, summarizeCycleWalls } from '@/lib/ci-cycles';
import type { Run } from '@/lib/types';

type TimingRun = Run & { attemptTiming?: { triggerAt?: string; completedAt?: string; runtimeSeconds?: number } };

function makeRun(overrides: Partial<TimingRun> & Pick<Run, 'id' | 'created_at'>): TimingRun {
  return {
    runAttempt: 1,
    attemptTiming: overrides.runAttempt === 2 ? undefined : { triggerAt: overrides.created_at, completedAt: overrides.updated_at ?? overrides.created_at },
    name: 'test workflow',
    head_branch: 'feature/x',
    head_sha: 'abc1234',
    status: 'completed',
    conclusion: 'failure',
    updated_at: overrides.updated_at ?? overrides.created_at,
    html_url: `https://github.com/o/r/actions/runs/${overrides.id}`,
    durationInSeconds: 0,
    jobs: [],
    ...overrides,
  };
}

function failedRun(id: number, created: string, end: string): Run {
  return makeRun({
    id,
    created_at: created,
    updated_at: end,
    conclusion: 'failure',
    workflowFile: 'pr-test-npu.yml',
    jobs: [
      {
        id: id * 10,
        runAttempt: 1,
        name: 'npu-e2e-failed-job',
        status: 'completed',
        conclusion: 'failure',
        created_at: created,
        started_at: created,
        completed_at: end,
        html_url: '',
        queueDurationInSeconds: 0,
        durationInSeconds: 0,
      },
    ],
  });
}

function build(cyclesRuns: Run[][]) {
  const runs = cyclesRuns.flat();
  const cycles = groupRunsIntoCycles(runs);
  return { cycles, stats: summarizeCycleWalls(cycles) };
}

describe('CiCycleGantt', () => {
  it('renders one row per cycle with colored bars and axis labels', () => {
    const { cycles, stats } = build([
      [
        makeRun({ id: 1, created_at: '2026-10-03T15:23:36Z', updated_at: '2026-10-03T18:23:36Z', conclusion: 'success', workflowFile: 'pr-test.yml' }),
        failedRun(2, '2026-10-03T15:23:36Z', '2026-10-03T15:29:24Z'),
      ],
      [
        failedRun(3, '2026-10-10T10:29:31Z', '2026-10-10T12:45:00Z'),
      ],
    ]);

    render(<CiCycleGantt cycles={cycles} stats={stats} />);

    expect(screen.getAllByTestId('cycle-row')).toHaveLength(2);
    const bars = screen.getAllByTestId('cycle-bar');
    expect(bars).toHaveLength(3);
    expect(bars.some((bar) => bar.dataset.conclusion === 'success')).toBe(true);
    expect(bars.filter((bar) => bar.dataset.conclusion === 'failure')).toHaveLength(2);
  });

  it('shows span/busy/idle summary with union semantics', () => {
    const { cycles, stats } = build([
      [
        makeRun({ id: 1, created_at: '2026-10-03T15:23:36Z', updated_at: '2026-10-05T18:05:58Z', conclusion: 'cancelled', workflowFile: 'pr-test.yml' }),
      ],
    ]);
    const { container } = render(<CiCycleGantt cycles={cycles} stats={stats} />);
    // span = 50.7h, busy = 50.7h, idle = 0
    expect(container.textContent).toContain('PR span');
    expect(container.textContent).toContain('idle');
  });

  it('exposes failed job names on hover without fabricating a root cause', () => {
    const { cycles, stats } = build([
      [failedRun(1, '2026-10-03T15:23:36Z', '2026-10-03T15:29:24Z')],
    ]);
    render(<CiCycleGantt cycles={cycles} stats={stats} />);

    fireEvent.mouseEnter(screen.getByTestId('cycle-row'));
    const tooltip = screen.getByTestId('cycle-tooltip');
    expect(tooltip.textContent).toContain('pr-test-npu.yml');
    expect(tooltip.textContent).toContain('npu-e2e-failed-job');
    expect(tooltip.textContent).toContain('root cause needs the run log');
    expect(tooltip.textContent).toContain('abc1234'.slice(0, 7));
  });

  it('supports keyboard focus for the tooltip', () => {
    const { cycles, stats } = build([
      [failedRun(1, '2026-10-03T15:23:36Z', '2026-10-03T15:29:24Z')],
    ]);
    render(<CiCycleGantt cycles={cycles} stats={stats} />);

    fireEvent.focus(screen.getByTestId('cycle-row'));
    expect(screen.getByTestId('cycle-tooltip')).toBeInTheDocument();
    fireEvent.blur(screen.getByTestId('cycle-row'));
    expect(screen.queryByTestId('cycle-tooltip')).not.toBeInTheDocument();
  });

  it('renders empty state without cycles', () => {
    render(<CiCycleGantt cycles={[]} stats={summarizeCycleWalls([])} />);
    expect(screen.getByText(/No CI cycles/i)).toBeInTheDocument();
  });

  it('shows an unknown attempt without drawing it or calling the uncovered span idle', () => {
    const [first, rerun] = fixture.attempts;
    const created_at = first.trigger!;
    const { cycles, stats } = build([[
      makeRun({ id: fixture.run_id, created_at, runAttempt: 1,
        attemptTiming: { triggerAt: created_at, completedAt: first.completed_at } }),
      makeRun({ id: fixture.run_id, created_at, runAttempt: 2, conclusion: 'success',
        attemptTiming: { runtimeSeconds: fixture.expected.rerun_runtime_seconds } }),
    ]]);
    const { container } = render(<CiCycleGantt cycles={cycles} stats={stats} mergedAt={rerun.completed_at} />);
    expect(screen.getAllByTestId('cycle-bar')).toHaveLength(1);
    expect(container.textContent).toContain('coverage incomplete');
    expect(container.textContent).not.toContain('idle between pushes');
    fireEvent.focus(screen.getByTestId('cycle-row'));
    expect(screen.getByTestId('cycle-tooltip').textContent).toContain('success');
    expect(screen.getByTestId('cycle-tooltip').textContent).toContain('Runtime 1h 29m');
    expect(screen.getByTestId('cycle-tooltip').textContent).toContain('wall unknown');
  });
});
