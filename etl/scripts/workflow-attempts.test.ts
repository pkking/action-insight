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
    runAttempt: 2,
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
    const [attempt] = buildWorkflowAttempts([run()], config, repoConfig, '2026-07-03T01:00:00Z');

    expect(attempt).toEqual(expect.objectContaining({
      run_id: 100,
      run_attempt: 2,
      tracked: true,
      workflow_file: 'ci.yml',
      workflow_ref: 'main',
      match_kind: 'exact_ref',
      queue_duration_seconds: 60,
      runtime_seconds: 600,
      total_duration_seconds: 660,
      pr_numbers: [42],
    }));
    expect(attempt.jobs[0]).toEqual(expect.objectContaining({
      run_attempt: 2,
      job_id: 10,
      runtime_seconds: 540,
      total_duration_seconds: 600,
    }));
    expect(attempt.jobs[0].steps).toHaveLength(1);
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
