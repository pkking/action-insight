import { createHash } from 'node:crypto';

import type { Run, Job, PullRequestRef } from '../../src/lib/types.ts';
import type { BuildkitePipelineRule } from './repos-config.ts';

const API_ROOT = 'https://api.buildkite.com/v2';
const PER_PAGE = 100;
const MAX_RESULTS_PER_QUERY = 1000;
const TERMINAL_BUILD_STATES = new Set(['passed', 'failed', 'canceled', 'skipped', 'not_run', 'waiting_failed']);
const TERMINAL_JOB_STATES = new Set(['passed', 'failed', 'timed_out', 'canceled', 'skipped', 'broken', 'expired', 'limited', 'blocked_failed', 'unblocked_failed', 'waiting_failed']);

interface BuildkiteJobPayload {
  id: string;
  type?: string;
  name?: string;
  step_key?: string;
  state: string;
  web_url?: string;
  created_at?: string;
  runnable_at?: string;
  started_at?: string;
  finished_at?: string;
}

interface BuildkiteBuildPayload {
  id: string;
  number: number;
  state: string;
  blocked?: boolean;
  message?: string;
  commit?: string;
  branch?: string;
  source?: string;
  web_url: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  pull_request?: { id?: number | string };
  pipeline?: { name?: string; slug?: string };
  jobs?: BuildkiteJobPayload[];
}

export interface BuildkiteCollectionWindow {
  start: string;
  end: string;
}

export interface FetchBuildkiteOptions {
  token: string;
  pipeline: BuildkitePipelineRule;
  window: BuildkiteCollectionWindow;
  skipJobs?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

export interface BuildkiteFetchResult {
  runs: Run[];
  saturated: boolean;
}

function nextDayIso(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

function secondsBetween(start?: string, end?: string): number {
  if (!start || !end) return 0;
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

/** ponytail: negative 52-bit hashes preserve the integer schema; migrate to provider-native string keys if collisions become material. */
export function stableBuildkiteId(identity: string): number {
  const hex = createHash('sha256').update(`buildkite:${identity}`).digest('hex').slice(0, 13);
  return -Math.max(1, Number.parseInt(hex, 16));
}

function buildStatus(state: string, blocked = false): { status: string; conclusion: string } {
  if (blocked) return { status: 'in_progress', conclusion: 'action_required' };
  if (!TERMINAL_BUILD_STATES.has(state)) {
    return { status: state === 'scheduled' ? 'queued' : 'in_progress', conclusion: 'unknown' };
  }
  const conclusions: Record<string, string> = {
    passed: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped',
    not_run: 'skipped', waiting_failed: 'failure',
  };
  return { status: 'completed', conclusion: conclusions[state] ?? 'unknown' };
}

function jobStatus(state: string): { status: string; conclusion: string } {
  if (!TERMINAL_JOB_STATES.has(state)) {
    return { status: ['pending', 'waiting', 'scheduled', 'assigned', 'accepted'].includes(state) ? 'queued' : 'in_progress', conclusion: 'unknown' };
  }
  const conclusions: Record<string, string> = {
    passed: 'success', failed: 'failure', timed_out: 'timed_out', canceled: 'cancelled',
    skipped: 'skipped', broken: 'failure', expired: 'failure', limited: 'failure',
    blocked_failed: 'failure', unblocked_failed: 'failure', waiting_failed: 'failure',
  };
  return { status: 'completed', conclusion: conclusions[state] ?? 'unknown' };
}

function pullRequests(build: BuildkiteBuildPayload): PullRequestRef[] | undefined {
  const number = Number(build.pull_request?.id);
  return Number.isInteger(number) && number > 0 ? [{ number }] : undefined;
}

function normalizeJob(pipeline: BuildkitePipelineRule, build: BuildkiteBuildPayload, raw: BuildkiteJobPayload): Job {
  const created = raw.created_at ?? build.created_at;
  const started = raw.started_at ?? raw.runnable_at ?? created;
  const completed = raw.finished_at ?? started;
  const state = jobStatus(raw.state);
  return {
    id: stableBuildkiteId(`job:${raw.id}`),
    name: raw.name ?? raw.step_key ?? raw.type ?? 'Buildkite job',
    status: state.status,
    conclusion: state.conclusion,
    created_at: created,
    started_at: started,
    completed_at: completed,
    html_url: raw.web_url ?? build.web_url,
    queueDurationInSeconds: secondsBetween(created, started),
    durationInSeconds: secondsBetween(started, completed),
    runtimeInSeconds: secondsBetween(started, completed),
    totalDurationInSeconds: secondsBetween(created, completed),
  };
}

export function normalizeBuildkiteBuild(pipeline: BuildkitePipelineRule, build: BuildkiteBuildPayload, skipJobs = false): Run {
  const status = buildStatus(build.state, build.blocked);
  const completed = build.finished_at ?? build.started_at ?? build.created_at;
  const workflowFile = `buildkite:${pipeline.organization}/${pipeline.pipeline}`;
  const jobs = skipJobs ? [] : (build.jobs ?? []).map((job) => normalizeJob(pipeline, build, job));
  return {
    id: stableBuildkiteId(`build:${build.id}`),
    provider: 'buildkite',
    runAttempt: 1,
    name: build.pipeline?.name ?? pipeline.pipeline,
    head_branch: build.branch ?? 'unknown',
    head_sha: build.commit,
    status: status.status,
    conclusion: status.conclusion,
    event: build.source ?? 'buildkite',
    created_at: build.created_at,
    run_started_at: build.started_at,
    updated_at: completed,
    html_url: build.web_url,
    durationInSeconds: secondsBetween(build.created_at, completed),
    queueDurationInSeconds: secondsBetween(build.created_at, build.started_at),
    runtimeInSeconds: secondsBetween(build.started_at, completed),
    workflowFile,
    workflowRef: build.branch ?? 'unknown',
    workflowPath: `${workflowFile}@${build.branch ?? 'unknown'}`,
    workflowParseStatus: 'ok',
    workflowMatchKind: 'provider',
    stepPolicyHash: `buildkite:${pipeline.organization}/${pipeline.pipeline}:jobs-only:v1`,
    tracked: true,
    pull_requests: pullRequests(build),
    jobs,
  };
}

async function requestPage(
  url: URL,
  token: string,
  fetchImpl: typeof fetch,
  sleepImpl: (milliseconds: number) => Promise<void>,
): Promise<BuildkiteBuildPayload[]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      if (attempt === 3) throw error;
      await sleepImpl(2 ** attempt * 1000);
      continue;
    }
    if (response.ok) return response.json() as Promise<BuildkiteBuildPayload[]>;
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`Buildkite API ${response.status}: ${await response.text()}`);
    }
    if (attempt === 3) throw new Error(`Buildkite API ${response.status}: ${await response.text()}`);
    const resetSeconds = Math.max(
      Number(response.headers.get('ratelimit-reset') ?? 0),
      Number(response.headers.get('ratelimit-user-reset') ?? 0),
      2 ** attempt,
    );
    await sleepImpl(resetSeconds * 1000);
  }
  return [];
}

export async function fetchBuildkitePipelineBuilds(options: FetchBuildkiteOptions): Promise<BuildkiteFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const runs: Run[] = [];
  const ids = new Map<number, string>();

  for (let page = 1; page <= MAX_RESULTS_PER_QUERY / PER_PAGE; page += 1) {
    const { organization, pipeline } = options.pipeline;
    const url = new URL(`${API_ROOT}/organizations/${encodeURIComponent(organization)}/pipelines/${encodeURIComponent(pipeline)}/builds`);
    url.searchParams.set('created_from', `${options.window.start}T00:00:00Z`);
    url.searchParams.set('created_to', nextDayIso(options.window.end));
    url.searchParams.set('include_retried_jobs', 'true');
    url.searchParams.set('exclude_pipeline', 'true');
    url.searchParams.set('exclude_jobs', String(Boolean(options.skipJobs)));
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));

    const builds = await requestPage(url, options.token, fetchImpl, sleepImpl);
    for (const build of builds) {
      const run = normalizeBuildkiteBuild(options.pipeline, build, options.skipJobs);
      const previous = ids.get(run.id);
      if (previous && previous !== build.id) {
        throw new Error(`Buildkite ID collision: ${previous} and ${build.id}`);
      }
      ids.set(run.id, build.id);
      runs.push(run);
    }
    if (builds.length < PER_PAGE) return { runs, saturated: false };
  }
  return { runs, saturated: true };
}
