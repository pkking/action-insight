import { describe, expect, it } from 'vitest';

import {
  computeCardHoursSummary,
  computeCycleBusySeconds,
  groupRunsIntoCycles,
  mergeAttemptRows,
  summarizeCycleWalls,
} from './ci-cycles';
import type { Run } from './types';

function makeRun(overrides: Partial<Run> & Pick<Run, 'id' | 'created_at'>): Run {
  return {
    name: 'test workflow',
    head_branch: 'feature/x',
    status: 'completed',
    conclusion: 'success',
    updated_at: overrides.updated_at ?? overrides.created_at,
    html_url: `https://github.com/o/r/actions/runs/${overrides.id}`,
    durationInSeconds: 0,
    jobs: [],
    ...overrides,
  };
}


describe('groupRunsIntoCycles', () => {
  it('groups runs sharing head_sha and created_at into one cycle', () => {
    const runs = [
      makeRun({ id: 1, head_sha: 'abc', created_at: '2026-10-03T15:23:36Z', updated_at: '2026-10-05T18:05:58Z', conclusion: 'cancelled', workflowFile: 'pr-test.yml' }),
      makeRun({ id: 2, head_sha: 'abc', created_at: '2026-10-03T15:23:36Z', updated_at: '2026-10-03T15:29:24Z', conclusion: 'failure', workflowFile: 'pr-test-npu.yml' }),
      makeRun({ id: 3, head_sha: 'def', created_at: '2026-10-10T10:29:31Z', updated_at: '2026-10-10T12:45:00Z', conclusion: 'failure', workflowFile: 'pr-test-npu.yml' }),
    ];

    const cycles = groupRunsIntoCycles(runs);
    expect(cycles).toHaveLength(2);

    const [latest, first] = cycles;
    expect(latest.startedAt).toBe('2026-10-10T10:29:31Z');
    expect(latest.runs).toHaveLength(1);
    expect(latest.wallSeconds).toBe(2 * 3600 + 15 * 60 + 29);

    expect(first.startedAt).toBe('2026-10-03T15:23:36Z');
    expect(first.runs).toHaveLength(2);
    // Wall uses the latest end within the batch (the 2-day cancelled run).
    expect(first.wallSeconds).toBe(
      Math.round(
        (Date.parse('2026-10-05T18:05:58Z') -
          Date.parse('2026-10-03T15:23:36Z')) /
          1000,
      ),
    );
  });

  it('keeps same-timestamp runs with different head_sha in separate cycles', () => {
    const runs = [
      makeRun({ id: 1, head_sha: 'abc', created_at: '2026-10-03T15:23:36Z' }),
      makeRun({ id: 2, head_sha: 'def', created_at: '2026-10-03T15:23:36Z' }),
    ];
    expect(groupRunsIntoCycles(runs)).toHaveLength(2);
  });

  it('splits rerun attempts sharing a head_sha into their own cycles', () => {
    // A UI rerun keeps head_sha but gets a new attempt created_at — the user
    // waited again, so it must be a separate cycle, never merged into the
    // original push batch.
    const runs = [
      makeRun({ id: 7, runAttempt: 1, head_sha: 'abc', created_at: '2026-10-03T15:23:36Z', updated_at: '2026-10-03T18:00:00Z' }),
      makeRun({ id: 7, runAttempt: 2, head_sha: 'abc', created_at: '2026-10-04T09:00:00Z', updated_at: '2026-10-04T11:30:00Z' }),
    ];
    const cycles = groupRunsIntoCycles(runs);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].runs[0].runAttempt).toBe(2);
    expect(cycles[1].runs[0].runAttempt).toBe(1);
  });

  it('marks a cycle open when no run has an end timestamp', () => {
    const runs = [
      makeRun({ id: 1, head_sha: 'abc', created_at: '2026-10-17T07:03:34Z', updated_at: '' }),
    ];
    const cycles = groupRunsIntoCycles(runs);
    // Empty updated_at falls back to created_at, which is still parseable;
    // force a fully unparseable end to exercise the open path.
    const open = groupRunsIntoCycles([
      makeRun({ id: 2, head_sha: 'zzz', created_at: '2026-10-17T07:03:34Z', updated_at: 'not-a-date' }),
    ]);
    expect(cycles[0].wallSeconds).toBe(0);
    expect(open[0].endedAt).toBeUndefined();
    expect(open[0].wallSeconds).toBeUndefined();
  });

  it('skips runs with unparseable created_at', () => {
    const runs = [
      makeRun({ id: 1, head_sha: 'abc', created_at: 'not-a-date' }),
    ];
    expect(groupRunsIntoCycles(runs)).toHaveLength(0);
  });

  it('propagates branchMatched flags to cycle run summaries', () => {
    const runs = [
      makeRun({ id: 1, head_sha: 'abc', created_at: '2026-10-03T15:23:36Z', branchMatched: true }),
    ];
    expect(groupRunsIntoCycles(runs)[0].runs[0].branchMatched).toBe(true);
  });

  it('rolls up failed and cancelled jobs per run with capped, unique names', () => {
    const failedJob = (id: number, name: string) => ({
      id,
      runAttempt: 1,
      name,
      status: 'completed',
      conclusion: 'failure',
      created_at: '',
      started_at: '',
      completed_at: '',
      html_url: '',
    });
    const runs = [
      makeRun({
        id: 9,
        head_sha: 'abc',
        created_at: '2026-10-03T15:23:36Z',
        conclusion: 'failure',
        jobs: [
          failedJob(1, 'npu-test-a'),
          failedJob(2, 'npu-test-a'), // duplicate name collapses
          failedJob(3, 'npu-test-b'),
          { id: 4, runAttempt: 1, name: 'hung-job', status: 'completed', conclusion: 'cancelled', created_at: '', started_at: '', completed_at: '', html_url: '' },
          { id: 5, runAttempt: 1, name: 'skipped-job', status: 'completed', conclusion: 'skipped', created_at: '', started_at: '', completed_at: '', html_url: '' },
        ],
      }),
    ];
    const run = groupRunsIntoCycles(runs)[0].runs[0];
    expect(run.failedJobCount).toBe(3);
    expect(run.failedJobNames).toEqual(['npu-test-a', 'npu-test-b']);
    expect(run.cancelledJobCount).toBe(1);
  });
});

describe('summarizeCycleWalls', () => {
  it('computes nearest-rank median/p90/max over closed cycles', () => {
    const hours = [3, 5, 10, 1, 4];
    const cycles = hours.map((h, i) =>
      makeRun({
        id: i,
        head_sha: `s${i}`,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: `2026-10-01T${String(h).padStart(2, '0')}:00:00Z`,
      }),
    );
    const stats = summarizeCycleWalls(groupRunsIntoCycles(cycles));
    expect(stats.cycleCount).toBe(5);
    expect(stats.openCycleCount).toBe(0);
    expect(stats.medianWallSeconds).toBe(4 * 3600);
    expect(stats.maxWallSeconds).toBe(10 * 3600);
    expect(stats.totalWallSeconds).toBe((3 + 5 + 10 + 1 + 4) * 3600);
  });

  it('excludes open cycles from percentile samples but counts them', () => {
    const cycles = [
      ...groupRunsIntoCycles([
        makeRun({ id: 1, head_sha: 'a', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T02:00:00Z' }),
      ]),
      ...groupRunsIntoCycles([
        makeRun({ id: 2, head_sha: 'b', created_at: '2026-10-02T00:00:00Z', updated_at: 'not-a-date' }),
      ]),
    ];
    const stats = summarizeCycleWalls(cycles);
    expect(stats.cycleCount).toBe(2);
    expect(stats.openCycleCount).toBe(1);
    expect(stats.medianWallSeconds).toBe(2 * 3600);
  });
});

describe('computeCardHoursSummary', () => {
  it('splits card-hours by conclusion and keeps cancelled in totals', () => {
    const jobs = [
      { resourceModel: 'a3-800t', resourceCount: 2, runtimeSeconds: 3600, conclusion: 'success' },
      { resourceModel: 'a3-800t', resourceCount: 4, runtimeSeconds: 1800, conclusion: 'failure' },
      { resourceModel: 'a3-800t', resourceCount: 4, runtimeSeconds: 3600, conclusion: 'cancelled' },
    ];
    const summary = computeCardHoursSummary(jobs);
    expect(summary.byConclusion.success).toBeCloseTo(2, 5);
    expect(summary.byConclusion.failure).toBeCloseTo(2, 5);
    expect(summary.byConclusion.cancelled).toBeCloseTo(4, 5);
    expect(summary.totalCardHours).toBeCloseTo(8, 5);
    expect(summary.perModel[0]).toMatchObject({
      resourceModel: 'a3-800t',
      cardHours: 8,
      jobCount: 3,
    });
  });

  it('counts unknown-cost and unattributed jobs without zero-filling', () => {
    const jobs = [
      { resourceModel: undefined, runtimeSeconds: 3600, conclusion: 'success' },
      { resourceModel: 'a3-800t', runtimeSeconds: 3600, conclusion: 'success' },
      { resourceModel: 'a3-800t', resourceCount: 2, runtimeSeconds: undefined, conclusion: 'success' },
    ];
    const summary = computeCardHoursSummary(jobs);
    expect(summary.totalCardHours).toBe(0);
    expect(summary.unattributedJobCount).toBe(1);
    expect(summary.unknownCostCount).toBe(2);
  });

  it('returns zeroed summary for empty input', () => {
    const summary = computeCardHoursSummary([]);
    expect(summary.totalCardHours).toBe(0);
    expect(summary.unattributedJobCount).toBe(0);
  });
});

describe('computeCycleBusySeconds', () => {
  it('returns the interval union, counting overlaps once', () => {
    const cycles = groupRunsIntoCycles([
      makeRun({ id: 1, head_sha: 'a', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T10:00:00Z' }),
      // overlaps the first cycle by 4h
      makeRun({ id: 2, head_sha: 'b', created_at: '2026-10-01T06:00:00Z', updated_at: '2026-10-01T12:00:00Z' }),
      // disjoint, 1h
      makeRun({ id: 3, head_sha: 'c', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T01:00:00Z' }),
    ]);
    // union = [00:00→12:00] + [next 1h] = 13h, not the 10+6+1=17h naive sum
    expect(computeCycleBusySeconds(cycles)).toBe(13 * 3600);
  });

  it('ignores open cycles and returns 0 for empty input', () => {
    expect(computeCycleBusySeconds([])).toBe(0);
    const open = groupRunsIntoCycles([
      makeRun({ id: 1, head_sha: 'a', created_at: '2026-10-01T00:00:00Z', updated_at: 'not-a-date' }),
    ]);
    expect(computeCycleBusySeconds(open)).toBe(0);
  });
});

describe('mergeAttemptRows', () => {
  it('dedupes branch-matched rows against linked rows and tags sources', () => {
    const linked = [{ run_id: 1, run_attempt: 1 }];
    const branchMatched = [
      { run_id: 1, run_attempt: 1 },
      { run_id: 2, run_attempt: 1 },
      { run_id: 2, run_attempt: 2 },
    ];
    const merged = mergeAttemptRows(linked, branchMatched);
    expect(merged).toEqual([
      { run_id: 1, run_attempt: 1, branchMatched: false },
      { run_id: 2, run_attempt: 1, branchMatched: true },
      { run_id: 2, run_attempt: 2, branchMatched: true },
    ]);
  });

  it('handles empty inputs', () => {
    expect(mergeAttemptRows([], [])).toEqual([]);
    expect(mergeAttemptRows([], [{ run_id: 9, run_attempt: 1 }])).toEqual([
      { run_id: 9, run_attempt: 1, branchMatched: true },
    ]);
  });
});
