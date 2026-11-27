import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { fetchWorkflowAttemptRunsFromClient } from './rebuild-pr-artifacts';
import { buildPullRequestIndex } from '../../src/lib/pr-metrics';

function clientFor(attempts: Record<string, unknown>[], jobs: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM workflow_attempts wa')) return { rows: attempts };
    if (sql.includes('FROM workflow_jobs wj')) return { rows: jobs };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}

const common = {
  id: 42, name: 'CI', head_branch: 'feature', head_sha: 'abc', event: 'pull_request', html_url: 'https://example.test/run',
  parent_created_at: '2026-04-01T00:00:00Z', parent_updated_at: '2026-04-04T01:29:18Z',
  created_at: '2026-04-01T00:00:00Z', status: 'completed', conclusion: 'success', workflow_file: 'ci.yml',
};

describe('rebuild workflow attempt timing', () => {
  it('retains the PR envelope and successful attempt associations while separating verified timing', async () => {
    const { client, query } = clientFor([
      { ...common, run_attempt: 1, conclusion: 'failure', completed_at: '2026-04-02T16:00:00Z', updated_at: '2026-04-02T16:00:00Z',
        timing_evidence: { version: 1, queue_duration_seconds: 0, runtime_seconds: 143900, total_duration_seconds: 144000 } },
      { ...common, run_attempt: 2, completed_at: null, updated_at: '2026-04-04T01:29:18Z',
        run_started_at: '2026-04-04T00:00:00Z', runtime_seconds: 99999, total_duration_seconds: 99999,
        timing_evidence: { version: 1, runtime_seconds: 5358, completion_source: 'attempt_response' } },
    ], [
      { run_id: 42, run_attempt: 2, job_id: 7, queue_duration_seconds: 999, runtime_seconds: 999,
        timing_evidence: { version: 1, queue_duration_seconds: 45, runtime_seconds: 5300 } },
    ]);
    const runs = await fetchWorkflowAttemptRunsFromClient(client, 1, ['2026-04-01']);
    expect(query.mock.calls[0][0]).toContain("to_jsonb(wa)->'timing_evidence'");
    expect(query.mock.calls[1][0]).toContain("to_jsonb(wj)->'timing_evidence'");
    expect(runs[0]).toMatchObject({ durationInSeconds: 144000, queueDurationInSeconds: 0, runtimeInSeconds: 143900 });
    expect(runs[1]).toMatchObject({ durationInSeconds: undefined, queueDurationInSeconds: undefined, runtimeInSeconds: 5358,
      parentUpdatedAt: '2026-04-04T01:29:18Z', updated_at: '2026-04-04T01:29:18Z' });
    expect(runs[1].jobs?.[0]).toMatchObject({ queueDurationInSeconds: 45, durationInSeconds: 5300, totalDurationInSeconds: undefined });

    const { index, details } = buildPullRequestIndex({ repo: 'owner/repo',
      runs: runs.map((run) => ({ ...run, pull_requests: [{ number: 123 }] })), pullRequests: new Map() });
    expect(index.prs[0]).toMatchObject({ ci_started_at: '2026-04-01T00:00:00Z', ci_completed_at: '2026-04-04T01:29:18Z',
      ciDurationInSeconds: 264558, workflowCount: 2, successfulWorkflowCount: 1, conclusion: 'success' });
    expect(details.get(123)?.pr.workflows.map(({ id, runAttempt, conclusion }) => ({ id, runAttempt, conclusion })))
      .toEqual(expect.arrayContaining([{ id: 42, runAttempt: 1, conclusion: 'failure' }, { id: 42, runAttempt: 2, conclusion: 'success' }]));
  });

  it('treats missing, unsupported and invalid evidence as unknown without using legacy columns', async () => {
    const { client } = clientFor([
      { ...common, run_attempt: 1, completed_at: null, updated_at: '', queue_duration_seconds: 0, runtime_seconds: 20, total_duration_seconds: 30 },
      { ...common, run_attempt: 2, completed_at: null, updated_at: '', timing_evidence: { version: 2, runtime_seconds: 20 } },
      { ...common, run_attempt: 3, completed_at: null, updated_at: '', timing_evidence: { version: 1, queue_duration_seconds: -1, runtime_seconds: '20', total_duration_seconds: Infinity } },
    ], [{ run_id: 42, run_attempt: 1, job_id: 9, queue_duration_seconds: 0, runtime_seconds: 20, duration_seconds: 30 }]);
    const runs = await fetchWorkflowAttemptRunsFromClient(client, 1, ['2026-04-01']);
    for (const run of runs) {
      expect(run).toMatchObject({ durationInSeconds: undefined, queueDurationInSeconds: undefined, runtimeInSeconds: undefined, updated_at: '' });
    }
    expect(runs[0].jobs?.[0]).toMatchObject({ queueDurationInSeconds: undefined, durationInSeconds: undefined, runtimeInSeconds: undefined, totalDurationInSeconds: undefined });
  });
});
