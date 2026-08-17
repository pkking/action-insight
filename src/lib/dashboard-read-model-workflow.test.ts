import { describe, expect, it, vi } from 'vitest';

// dashboard-read-model imports 'server-only' to stay off the client bundle.
// Stub it so the pure transform helpers can be tested in jsdom.
vi.mock('server-only', () => ({}));

import {
  buildWorkflowCards,
  buildWorkflowDashboardResult,
  type CostJobRow,
  type WorkflowAttemptRow,
} from './dashboard-read-model';

function attempt(overrides: Partial<WorkflowAttemptRow> = {}): WorkflowAttemptRow {
  return {
    repoKey: 'owner/repo',
    runId: 1,
    runAttempt: 1,
    runDate: '2026-01-01',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    queueDurationSeconds: 120,
    runtimeSeconds: 3480,
    totalDurationSeconds: 3600,
    conclusion: 'success',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function job(overrides: Partial<CostJobRow> = {}): CostJobRow {
  return {
    repoKey: 'owner/repo',
    runId: 1,
    runAttempt: 1,
    jobId: 1,
    runDate: '2026-01-01',
    workflowFile: 'ci.yml',
    workflowRef: 'refs/heads/main',
    resourceModel: 'npu-a3',
    resourceCount: 4,
    runtimeSeconds: 3600,
    attemptConclusion: 'success',
    attemptTotalDurationSeconds: 3600,
    ...overrides,
  };
}

describe('buildWorkflowCards', () => {
  it('counts all tracked attempts and computes success rate over terminal only', () => {
    const attempts = [
      attempt({ runId: 1, conclusion: 'success' }),
      attempt({ runId: 2, conclusion: 'failure' }),
      attempt({ runId: 3, conclusion: null, status: 'in_progress' }), // non-terminal
    ];
    const cards = buildWorkflowCards(attempts, [], false);
    expect(cards.totalAttempts).toBe(3);
    expect(cards.successRate).toBe(50); // 1 success / 2 terminal
    expect(cards.contributingRepoCount).toBe(1);
  });

  it('computes P50/P90 over successful total durations only', () => {
    const attempts = [
      attempt({ runId: 1, conclusion: 'success', totalDurationSeconds: 100 }),
      attempt({ runId: 2, conclusion: 'success', totalDurationSeconds: 200 }),
      attempt({ runId: 3, conclusion: 'failure', totalDurationSeconds: 9999 }), // excluded from percentile
    ];
    const cards = buildWorkflowCards(attempts, [], false);
    expect(cards.p50TotalDuration).toBe(100);
    expect(cards.p90TotalDuration).toBe(200);
  });

  it('returns undefined percentiles when there are no successful samples', () => {
    const cards = buildWorkflowCards(
      [attempt({ conclusion: 'failure' })],
      [],
      false,
    );
    expect(cards.p50TotalDuration).toBeUndefined();
    expect(cards.p90TotalDuration).toBeUndefined();
  });

  it('reports top-Machine-Hour workflow only for a single repo', () => {
    const jobRows = [
      job({ workflowFile: 'a.yml', runtimeSeconds: 3600, resourceCount: 4 }),
      job({ workflowFile: 'b.yml', runtimeSeconds: 7200, resourceCount: 4 }),
    ];
    expect(buildWorkflowCards([], jobRows, false).topWorkflow).toBeUndefined();
    expect(buildWorkflowCards([], jobRows, true).topWorkflow?.workflowFile).toBe('b.yml');
    expect(buildWorkflowCards([], jobRows, true).topWorkflow?.machineHours).toBe(8);
  });
});

describe('buildWorkflowDashboardResult', () => {
  it('builds a daily attempt-count series per repo (all repos)', () => {
    const attempts = [
      attempt({ runId: 1, runDate: '2026-01-01', repoKey: 'a/b' }),
      attempt({ runId: 2, runDate: '2026-01-01', repoKey: 'a/b' }),
      attempt({ runId: 3, runDate: '2026-01-02', repoKey: 'c/d' }),
    ];
    const cards = buildWorkflowCards(attempts, [], false);
    const result = buildWorkflowDashboardResult(attempts, [], cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.series).toEqual([
      { date: '2026-01-01', key: 'a/b', attempts: 2 },
      { date: '2026-01-02', key: 'c/d', attempts: 1 },
    ]);
  });

  it('builds a daily attempt-count series per workflow file (one repo)', () => {
    const attempts = [
      attempt({ runId: 1, runDate: '2026-01-01', workflowFile: 'ci.yml' }),
      attempt({ runId: 2, runDate: '2026-01-01', workflowFile: 'e2e.yml' }),
    ];
    const cards = buildWorkflowCards(attempts, [], true);
    const result = buildWorkflowDashboardResult(attempts, [], cards, true, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const ci = result.series.find((p) => p.key === 'ci.yml')!;
    const e2e = result.series.find((p) => p.key === 'e2e.yml')!;
    expect(ci.attempts).toBe(1);
    expect(e2e.attempts).toBe(1);
  });

  it('groups jobs by (repo, workflow_file, workflow_ref, resource_model)', () => {
    const jobRows = [
      job({ runId: 1, jobId: 1, resourceModel: 'npu-a3' }),
      job({ runId: 1, jobId: 2, resourceModel: 'npu-a2' }),
      job({ runId: 2, jobId: 3, resourceModel: 'npu-a3' }),
    ];
    const cards = buildWorkflowCards([], jobRows, false);
    const result = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(2);
    const a3 = result.rows.find((r) => r.resourceModel === 'npu-a3')!;
    expect(a3.attemptCount).toBe(2);
    expect(a3.machineHours).toBe(8);
  });

  it('keeps same-name workflows from different refs distinct', () => {
    const jobRows = [
      job({ workflowRef: 'refs/heads/main' }),
      job({ runId: 2, workflowRef: 'refs/heads/dev' }),
    ];
    const cards = buildWorkflowCards([], jobRows, false);
    const result = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((r) => r.workflowRef)).size).toBe(2);
  });

  it('caps groups at the observation limit and reports truncation', () => {
    const jobRows = Array.from({ length: 600 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, workflowFile: `wf${i}.yml`, runDate: '2026-01-01' }),
    );
    const cards = buildWorkflowCards([], jobRows, false);
    const result = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.truncated).toBe(true);
    expect(result.displayedObservationCount).toBe(500);
    expect(result.totalRows).toBe(500);
  });

  it('counts unknown-cost jobs in quality', () => {
    const jobRows = [
      job({ jobId: 1, resourceCount: 4, runtimeSeconds: 3600 }),
      job({ jobId: 2, resourceCount: 0, runtimeSeconds: 3600 }),
    ];
    const cards = buildWorkflowCards([], jobRows, false);
    const result = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.quality.unknownResourceSamples).toBe(1);
    expect(result.rows[0].unknownCostCount).toBe(1);
  });

  it('paginates the table over the bounded groups', () => {
    const jobRows = Array.from({ length: 50 }, (_, i) =>
      job({ runId: i + 1, jobId: 1, workflowFile: `wf${i}.yml` }),
    );
    const cards = buildWorkflowCards([], jobRows, false);
    const page1 = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    const page2 = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 2,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(page1.rows).toHaveLength(20);
    expect(page2.rows).toHaveLength(20);
    expect(page1.rows[0].workflowFile).not.toBe(page2.rows[0].workflowFile);
  });

  it('orders groups newest-first by latest contributing run date', () => {
    const jobRows = [
      job({ runId: 1, workflowFile: 'old.yml', runDate: '2026-01-01' }),
      job({ runId: 2, workflowFile: 'new.yml', runDate: '2026-01-05' }),
    ];
    const cards = buildWorkflowCards([], jobRows, false);
    const result = buildWorkflowDashboardResult([], jobRows, cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows.map((r) => r.workflowFile)).toEqual(['new.yml', 'old.yml']);
  });

  it('returns an empty result when there are no attempts or jobs', () => {
    const cards = buildWorkflowCards([], [], false);
    const result = buildWorkflowDashboardResult([], [], cards, false, {
      page: 1,
      pageSize: 20,
      observationLimit: 500,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.series).toHaveLength(0);
    expect(cards.totalAttempts).toBe(0);
  });
});
