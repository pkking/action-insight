import { describe, expect, it } from 'vitest';

import type { Run } from './types';
import { buildPullRequestIndex } from './pr-metrics';

describe('buildPullRequestIndex', () => {
  it('aggregates workflow runs into PR-level lifecycle metrics and detail payloads', () => {
    const runs: Run[] = [
      {
        id: 101,
        name: 'lint',
        head_branch: 'feature/pr-metrics',
        status: 'completed',
        conclusion: 'success',
        event: 'pull_request',
        created_at: '2026-04-18T01:05:00Z',
        updated_at: '2026-04-18T01:15:00Z',
        html_url: 'https://github.com/acme/widgets/actions/runs/101',
        durationInSeconds: 600,
        pull_requests: [{ number: 42 }],
        jobs: [],
      },
      {
        id: 102,
        name: 'integration',
        head_branch: 'feature/pr-metrics',
        status: 'completed',
        conclusion: 'failure',
        event: 'pull_request',
        created_at: '2026-04-18T01:10:00Z',
        updated_at: '2026-04-18T01:45:00Z',
        html_url: 'https://github.com/acme/widgets/actions/runs/102',
        durationInSeconds: 2100,
        pull_requests: [{ number: 42 }],
        jobs: [],
      },
      {
        id: 201,
        name: 'nightly',
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        event: 'schedule',
        created_at: '2026-04-18T02:00:00Z',
        updated_at: '2026-04-18T02:30:00Z',
        html_url: 'https://github.com/acme/widgets/actions/runs/201',
        durationInSeconds: 1800,
        pull_requests: [],
        jobs: [],
      },
    ];

    const result = buildPullRequestIndex({
      repo: 'acme/widgets',
      runs,
      pullRequests: new Map([
        [
          42,
          {
            number: 42,
            title: 'Add PR lifecycle dashboard',
            state: 'closed',
            created_at: '2026-04-18T01:00:00Z',
            merged_at: '2026-04-18T02:15:00Z',
            html_url: 'https://github.com/acme/widgets/pull/42',
            user: {
              login: 'octocat',
            },
          },
        ],
      ]),
      generatedAt: '2026-04-18T03:00:00Z',
    });

    expect(result.index.prs).toHaveLength(1);
    expect(result.index.prs[0]).toMatchObject({
      number: 42,
      title: 'Add PR lifecycle dashboard',
      branch: 'feature/pr-metrics',
      author: 'octocat',
      workflowCount: 2,
      successfulWorkflowCount: 1,
      conclusion: 'failure',
      created_at: '2026-04-18T01:00:00Z',
      ci_started_at: '2026-04-18T01:05:00Z',
      ci_completed_at: '2026-04-18T01:45:00Z',
      merged_at: '2026-04-18T02:15:00Z',
      timeToCiStartInSeconds: 300,
      ciDurationInSeconds: 2400,
      timeToMergeInSeconds: 4500,
      mergeLeadTimeInSeconds: 1800,
    });

    expect(result.details.get(42)).toMatchObject({
      repo: 'acme/widgets',
      generated_at: '2026-04-18T03:00:00Z',
      pr: {
        number: 42,
        workflows: [
          expect.objectContaining({ id: 102, name: 'integration' }),
          expect.objectContaining({ id: 101, name: 'lint' }),
        ],
      },
    });
  });

  it('keeps PRs visible even before merge and leaves merge metrics undefined', () => {
    const runs: Run[] = [
      {
        id: 301,
        name: 'ci',
        head_branch: 'feature/open-pr',
        status: 'completed',
        conclusion: 'success',
        event: 'pull_request',
        created_at: '2026-04-18T05:02:00Z',
        updated_at: '2026-04-18T05:12:00Z',
        html_url: 'https://github.com/acme/widgets/actions/runs/301',
        durationInSeconds: 600,
        pull_requests: [{ number: 77 }],
        jobs: [],
      },
    ];

    const result = buildPullRequestIndex({
      repo: 'acme/widgets',
      runs,
      pullRequests: new Map([
        [
          77,
          {
            number: 77,
            title: 'Open PR',
            state: 'open',
            created_at: '2026-04-18T05:00:00Z',
            merged_at: null,
            html_url: 'https://github.com/acme/widgets/pull/77',
            user: {
              login: 'hubot',
            },
          },
        ],
      ]),
      generatedAt: '2026-04-18T06:00:00Z',
    });

    expect(result.index.prs[0]).toMatchObject({
      number: 77,
      state: 'open',
      timeToCiStartInSeconds: 120,
      ciDurationInSeconds: 600,
      timeToMergeInSeconds: undefined,
      mergeLeadTimeInSeconds: undefined,
    });
  });
});
