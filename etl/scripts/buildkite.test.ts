import { describe, expect, it, vi } from 'vitest';

import { fetchBuildkitePipelineBuilds, normalizeBuildkiteBuild, stableBuildkiteId } from './buildkite';

const pipeline = { organization: 'acme-ci', pipeline: 'widgets' };
const build = {
  id: 'build-uuid',
  number: 42,
  state: 'passed',
  message: 'Test PR',
  commit: 'abcdef',
  branch: 'feature/test',
  source: 'webhook',
  web_url: 'https://buildkite.com/acme-ci/widgets/builds/42',
  created_at: '2026-07-29T10:00:00Z',
  started_at: '2026-07-29T10:05:00Z',
  finished_at: '2026-07-29T10:35:00Z',
  pull_request: { id: '123' },
  jobs: [{
    id: 'job-uuid',
    type: 'script',
    name: 'tests',
    state: 'passed',
    web_url: 'https://buildkite.com/acme-ci/widgets/builds/42#job-uuid',
    created_at: '2026-07-29T10:02:00Z',
    started_at: '2026-07-29T10:07:00Z',
    finished_at: '2026-07-29T10:30:00Z',
  }],
};

describe('Buildkite collection adapter', () => {
  it('normalizes builds and jobs into the shared timing model', () => {
    const run = normalizeBuildkiteBuild(pipeline, build);

    expect(run).toMatchObject({
      provider: 'buildkite',
      runAttempt: 1,
      status: 'completed',
      conclusion: 'success',
      queueDurationInSeconds: 300,
      runtimeInSeconds: 1800,
      durationInSeconds: 2100,
      workflowFile: 'buildkite:acme-ci/widgets',
      workflowRef: 'feature/test',
      workflowMatchKind: 'provider',
      tracked: true,
      pull_requests: [{ number: 123 }],
    });
    expect(run.id).toBeLessThan(0);
    expect(run.jobs?.[0]).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      queueDurationInSeconds: 300,
      durationInSeconds: 1380,
      totalDurationInSeconds: 1680,
    });
  });

  it('uses stable safe integer identities without crossing GitHub positive IDs', () => {
    const first = stableBuildkiteId('build:abc');
    expect(first).toBe(stableBuildkiteId('build:abc'));
    expect(first).toBeLessThan(0);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).not.toBe(stableBuildkiteId('build:def'));
  });

  it('filters by collection window and paginates builds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...build, id: `build-${index}`, number: index }))), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ...build, id: 'build-last', number: 101 }]), { status: 200 }));

    const result = await fetchBuildkitePipelineBuilds({
      token: 'token', pipeline, window: { start: '2026-07-29', end: '2026-07-29' }, fetchImpl,
    });

    expect(result.runs).toHaveLength(101);
    expect(result.saturated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.searchParams.get('created_from')).toBe('2026-07-29T00:00:00Z');
    expect(firstUrl.searchParams.get('created_to')).toBe('2026-07-30T00:00:00.000Z');
    expect(firstUrl.searchParams.get('include_retried_jobs')).toBe('true');
  });

  it('waits for the larger organization or user reset after HTTP 429', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'RateLimit-Reset': '3', 'RateLimit-User-Reset': '7' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([build]), { status: 200 }));

    const result = await fetchBuildkitePipelineBuilds({
      token: 'token', pipeline, window: { start: '2026-07-29', end: '2026-07-29' }, fetchImpl, sleepImpl,
    });

    expect(result.runs).toHaveLength(1);
    expect(sleepImpl).toHaveBeenCalledWith(7000);
  });

  it('retries transient network failures', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify([build]), { status: 200 }));

    const result = await fetchBuildkitePipelineBuilds({
      token: 'token', pipeline, window: { start: '2026-07-29', end: '2026-07-29' }, fetchImpl, sleepImpl,
    });

    expect(result.runs).toHaveLength(1);
    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });

  it('keeps incomplete timestamps visible without inventing live duration', () => {
    const run = normalizeBuildkiteBuild(pipeline, {
      ...build,
      state: 'running',
      finished_at: undefined,
      jobs: [{ id: 'queued-job', state: 'scheduled', created_at: build.created_at }],
    });

    expect(run.status).toBe('in_progress');
    expect(run.updated_at).toBe(run.run_started_at);
    expect(run.jobs?.[0]).toMatchObject({ status: 'queued', queueDurationInSeconds: 0, durationInSeconds: 0 });
  });
});
