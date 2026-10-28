import { describe, expect, it } from 'vitest';

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

describe('buildWorkflowAttempts', () => {
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
      total_duration_seconds: 600,
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
    // Total = run_started → completed (matches GitHub UI), not created → completed.
    expect(rerun.total_duration_seconds).toBe(1736); // 28m56s, per GitHub UI
    expect(rerun.runtime_seconds).toBe(1736);
    // The pre-rerun idle gap is NOT queue; a rerun's queue is unknown.
    expect(rerun.queue_duration_seconds).toBeNull();

    // Attempt 1 keeps created-based semantics (queue included) — the base
    // fixture: created 00:00, first job started 00:01:30, updated 00:11.
    const [first] = buildWorkflowAttempts([run()], config, repoConfig);
    expect(first.total_duration_seconds).toBe(660);
    expect(first.queue_duration_seconds).toBe(90);
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
