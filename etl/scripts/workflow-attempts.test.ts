import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/attempt-timing-40h.json';

import { buildWorkflowAttempts } from './workflow-attempts';
import type { ReposConfig } from './repos-config';
import type { Run } from '../../src/lib/types';

const config: ReposConfig = {
  defaults: { stepsMinWorkflowDurationSeconds: 600 },
  repos: [
    {
      repo: 'acme/widgets',
      workflows: [
        { file: 'ci.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 300 },
        { file: 'nightly.yml' },
      ],
    },
  ],
};

const repoConfig = config.repos[0];

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 100,
    runAttempt: 1,
    name: 'CI',
    head_branch: 'feature',
    status: 'completed',
    conclusion: 'success',
    event: 'pull_request',
    created_at: '2026-07-03T00:00:00Z',
    run_started_at: '2026-07-03T00:01:00Z',
    updated_at: '2026-07-03T00:11:00Z',
    html_url: 'https://example.com/runs/100',
    durationInSeconds: 660,
    workflowPath: '.github/workflows/ci.yml@main',
    pull_requests: [{ number: 42 }],
    jobs: [
      {
        id: 10,
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-03T00:00:30Z',
        started_at: '2026-07-03T00:01:30Z',
        completed_at: '2026-07-03T00:10:30Z',
        html_url: 'https://example.com/jobs/10',
        queueDurationInSeconds: 60,
        durationInSeconds: 540,
        steps: [
          {
            number: 1,
            name: 'checkout',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-07-03T00:01:30Z',
            completed_at: '2026-07-03T00:02:00Z',
            duration_seconds: 30,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('timing evidence', () => {
  function evidencedRun(): Run & { jobsFetchedAt: string } {
    const base = run();
    const job = base.jobs![0];
    return {
      ...base,
      jobsFetchedAt: '2026-07-03T00:12:00Z',
      githubPayload: {
        id: base.id, run_attempt: 1, status: 'completed', created_at: base.created_at,
        run_started_at: base.run_started_at, completed_at: base.updated_at,
      },
      jobs: [{ ...job, githubPayload: {
        id: job.id, run_id: base.id, run_attempt: 1, status: job.status,
        created_at: job.created_at, started_at: job.started_at, completed_at: job.completed_at,
      } }],
    };
  }

  it('uses explicit completion from the shared rerun fixture', () => {
    const sample = fixture.attempts[1];
    expect(sample.trigger).toBeNull();
    const input = run({
      id: fixture.run_id, runAttempt: sample.run_attempt, jobs: [],
      githubPayload: { id: fixture.run_id, run_attempt: sample.run_attempt, status: 'completed',
        run_started_at: sample.run_started_at, completed_at: sample.completed_at },
    });
    const [attempt] = buildWorkflowAttempts([input], config, repoConfig);
    expect(attempt.timing_evidence).toEqual({ version: 1, runtime_seconds: 5358, completion_source: 'github_run.completed_at', completed_at: sample.completed_at });
  });

  it('persists verified explicit completion independently of the legacy updated time', () => {
    const input = evidencedRun();
    input.githubPayload!.completed_at = '2026-07-03T00:10:00Z';
    const [attempt] = buildWorkflowAttempts([input], config, repoConfig);
    expect(attempt.completed_at).toBe('2026-07-03T00:10:00Z');
    expect(attempt.updated_at).toBe('2026-07-03T00:11:00Z');
    expect(attempt.runtime_seconds).toBe(600);
    expect(attempt.timing_evidence?.runtime_seconds).toBe(540);
  });

  it('records a fetch marker for empty results but not cached jobs', () => {
    const empty = { ...run({ jobs: [] }), jobsFetchedAt: '2026-07-03T00:12:00Z' };
    const [fetched, cached] = buildWorkflowAttempts([empty, run()], config, repoConfig);
    expect(fetched.jobs_fetched_at).toBe(empty.jobsFetchedAt);
    expect(cached.jobs_fetched_at).toBeNull();
  });

  it('uses only bound raw endpoints for run and job evidence', () => {
    const [attempt] = buildWorkflowAttempts([evidencedRun()], config, repoConfig);
    expect(attempt.timing_evidence).toEqual({ version: 1, queue_duration_seconds: 90, runtime_seconds: 600,
      total_duration_seconds: 660, completion_source: 'github_run.completed_at', completed_at: '2026-07-03T00:11:00Z', trigger_at: '2026-07-03T00:00:00Z' });
    expect(attempt.jobs[0].timing_evidence).toEqual({ version: 1, queue_duration_seconds: 60,
      runtime_seconds: 540, total_duration_seconds: 600, completion_source: 'github_job.completed_at', completed_at: '2026-07-03T00:10:30Z' });
  });

  it('does not treat updated_at or mismatched run identity as completion evidence', () => {
    for (const payload of [
      { id: 100, run_attempt: 1, status: 'completed', updated_at: '2026-07-03T00:11:00Z', run_started_at: '2026-07-03T00:01:00Z' },
      { id: 101, run_attempt: 1, status: 'completed', completed_at: '2026-07-03T00:11:00Z', run_started_at: '2026-07-03T00:01:00Z' },
      { id: 100, status: 'completed', completed_at: '2026-07-03T00:11:00Z', run_started_at: '2026-07-03T00:01:00Z' },
      { id: 100, run_attempt: 2, status: 'completed', completed_at: '2026-07-03T00:11:00Z', run_started_at: '2026-07-03T00:01:00Z' },
      { id: 100, run_attempt: 1, status: 'in_progress', completed_at: '2026-07-03T00:11:00Z', run_started_at: '2026-07-03T00:01:00Z' },
    ]) {
      const [attempt] = buildWorkflowAttempts([run({ githubPayload: payload })], config, repoConfig);
      expect(attempt.timing_evidence).toBeUndefined();
    }
  });

  it('retains zero and omits reversed or missing raw intervals despite legacy values', () => {
    const input = evidencedRun();
    input.githubPayload = { ...input.githubPayload, run_started_at: input.updated_at, created_at: '2026-07-03T00:12:00Z' };
    input.jobs![0].githubPayload = { ...input.jobs![0].githubPayload,
      created_at: '2026-07-03T00:02:00Z', started_at: '2026-07-03T00:01:00Z', completed_at: '2026-07-03T00:01:00Z' };
    const [attempt] = buildWorkflowAttempts([input], config, repoConfig);
    expect(attempt.timing_evidence).toEqual({ version: 1, runtime_seconds: 0, completion_source: 'github_run.completed_at', completed_at: '2026-07-03T00:11:00Z' });
    expect(attempt.jobs[0].timing_evidence).toEqual({ version: 1, runtime_seconds: 0, completion_source: 'github_job.completed_at', completed_at: '2026-07-03T00:01:00Z' });
  });

  it('rejects absent or stale collection markers and wrong job ownership or attempt', () => {
    for (const change of ['missing', 'stale', 'owner', 'attempt', 'id']) {
      const input = evidencedRun();
      if (change === 'missing') input.jobsFetchedAt = '';
      if (change === 'stale') input.jobsFetchedAt = '2026-07-03T00:05:00Z';
      if (change === 'owner') input.jobs![0].githubPayload!.run_id = 999;
      if (change === 'attempt') input.jobs![0].githubPayload!.run_attempt = 2;
      if (change === 'id') input.jobs![0].githubPayload!.id = 999;
      const [attempt] = buildWorkflowAttempts([input], config, repoConfig);
      expect(attempt.timing_evidence?.queue_duration_seconds).toBeUndefined();
      expect(attempt.jobs[0].timing_evidence).toBeUndefined();
    }
  });
});

describe('buildWorkflowAttempts', () => {
  it('keeps the 40-hour gap out of rerun timing in the shared fixture', () => {
    const inputs = fixture.attempts.map((item) => run({
      id: fixture.run_id,
      runAttempt: item.run_attempt,
      created_at: fixture.attempts[0].trigger!,
      run_started_at: item.run_started_at,
      updated_at: item.completed_at,
    }));
    const rows = buildWorkflowAttempts(inputs, config, repoConfig);
    expect(rows).toHaveLength(2);
    expect(rows[1].runtime_seconds).toBe(fixture.expected.rerun_runtime_seconds);
    expect(rows[1].queue_duration_seconds).toBeNull();
    expect(rows[1].total_duration_seconds).toBeNull();
  });
  it('keeps rerun trigger timing unknown while retaining actual runtime', () => {
    const [attempt] = buildWorkflowAttempts([run({
      id: 44295850861, runAttempt: 2,
      created_at: '2026-11-18T11:34:00Z',
      run_started_at: '2026-11-20T03:32:00Z',
      updated_at: '2026-11-20T05:01:18Z',
      durationInSeconds: 149238,
    })], config, repoConfig);
    expect(attempt.queue_duration_seconds).toBeNull();
    expect(attempt.total_duration_seconds).toBeNull();
    expect(attempt.runtime_seconds).toBe(5358);
    expect(attempt.jobs[0].queue_duration_seconds).toBe(60);
    expect(attempt.jobs[0].steps).toHaveLength(1);
  });
  it('stores tracked workflow attempts with attempt identity and eligible steps', () => {
    const [attempt] = buildWorkflowAttempts([run({ runAttempt: 2 })], config, repoConfig, '2026-07-03T01:00:00Z');

    expect(attempt).toEqual(expect.objectContaining({
      run_id: 100,
      run_attempt: 2,
      tracked: true,
      workflow_file: 'ci.yml',
      workflow_ref: 'main',
      match_kind: 'exact_ref',
      queue_duration_seconds: null,
      runtime_seconds: 600,
      total_duration_seconds: null,
      pr_numbers: [42],
    }));
    expect(attempt.jobs[0]).toEqual(expect.objectContaining({
      run_attempt: 2,
      job_id: 10,
      queue_duration_seconds: 60,
      runtime_seconds: 540,
      total_duration_seconds: 600,
    }));
    expect(attempt.jobs[0].steps).toHaveLength(1);
  });

  it('uses the earliest started job for workflow queue and leaves it unavailable without one', () => {
    const [withJobs] = buildWorkflowAttempts([
      run({
        jobs: [
          { ...run().jobs![0], id: 11, started_at: '2026-07-03T00:03:00Z' },
          { ...run().jobs![0], id: 12, started_at: '2026-07-03T00:02:00Z' },
        ],
      }),
    ], config, repoConfig);
    expect(withJobs.queue_duration_seconds).toBe(120);

    const [withoutStartedJob] = buildWorkflowAttempts([
      run({ jobs: [{ ...run().jobs![0], started_at: '' }] }),
    ], config, repoConfig);
    expect(withoutStartedJob.queue_duration_seconds).toBeNull();
  });

  it('excludes the idle gap between attempts from rerun durations (ADR-023)', () => {
    // Run triggered 10-08 14:38, re-run days later: run_started_at is the
    // rerun's start; created_at still points at the original trigger.
    const [rerun] = buildWorkflowAttempts([
      run({
        runAttempt: 2,
        created_at: '2026-10-08T14:38:52Z',
        run_started_at: '2026-10-11T01:51:43Z',
        updated_at: '2026-10-11T02:20:39Z',
        durationInSeconds: 213_000, // legacy created-based value, must be ignored
      }),
    ], config, repoConfig);
    // No evidence of the rerun request time is available.
    expect(rerun.total_duration_seconds).toBeNull();
    expect(rerun.runtime_seconds).toBe(1736);
    // The pre-rerun idle gap is NOT queue; a rerun's queue is unknown.
    expect(rerun.queue_duration_seconds).toBeNull();

    // Attempt 1 keeps created-based semantics (queue included) — the base
    // fixture: created 00:00, first job started 00:01:30, updated 00:11.
    const [first] = buildWorkflowAttempts([run()], config, repoConfig);
    expect(first.total_duration_seconds).toBe(660);
    expect(first.queue_duration_seconds).toBe(90);
  });

  it('does not infer runtime from incomplete or reversed endpoints', () => {
    for (const overrides of [
      { status: 'in_progress' },
      { run_started_at: 'invalid' },
      { run_started_at: '2026-07-03T01:00:00Z' },
    ]) {
      const [attempt] = buildWorkflowAttempts([run({ runAttempt: 2, ...overrides })], config, repoConfig);
      expect(attempt.runtime_seconds).toBeNull();
      expect(attempt.total_duration_seconds).toBeNull();
    }
  });

  it('distinguishes a genuine zero from reversed first-attempt timestamps', () => {
    const [zero] = buildWorkflowAttempts([run({
      jobs: [{ ...run().jobs![0], started_at: '2026-07-03T00:00:00Z' }],
    })], config, repoConfig);
    expect(zero.queue_duration_seconds).toBe(0);
    const [reversed] = buildWorkflowAttempts([run({
      run_started_at: '2026-07-03T00:12:00Z',
      jobs: [{ ...run().jobs![0], started_at: '2026-07-02T23:59:00Z' }],
    })], config, repoConfig);
    expect(reversed.queue_duration_seconds).toBeNull();
    expect(reversed.runtime_seconds).toBeNull();
  });

  it('keeps run metadata for untracked workflows without persisting step rows', () => {
    const [attempt] = buildWorkflowAttempts([
      run({
        workflowPath: '.github/workflows/docs.yml@main',
      }),
    ], config, repoConfig);

    expect(attempt.tracked).toBe(false);
    expect(attempt.workflow_file).toBe('docs.yml');
    expect(attempt.jobs[0].steps).toBeUndefined();
  });

  it('does not persist steps for short successful tracked workflows', () => {
    const [attempt] = buildWorkflowAttempts([
      run({
        updated_at: '2026-07-03T00:04:00Z',
        durationInSeconds: 240,
      }),
    ], config, repoConfig);

    expect(attempt.tracked).toBe(true);
    expect(attempt.jobs[0].steps).toBeUndefined();
  });
});
