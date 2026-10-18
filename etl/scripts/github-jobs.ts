import type { Octokit } from '@octokit/core';

/** Raw jobs stay on the existing normalization/write paths in each caller. */
export interface GitHubJobPayload extends Record<string, unknown> {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  created_at?: string;
  started_at: string;
  completed_at?: string;
  html_url: string;
  labels?: unknown;
  runner_id?: unknown;
  runner_name?: unknown;
  runner_group_id?: unknown;
  runner_group_name?: unknown;
}

export interface GitHubRunJobsResponse {
  jobs: GitHubJobPayload[];
}

export class InvalidJobsResponseError extends Error {}

type Retry = <T>(operation: () => Promise<T>, context: string) => Promise<T>;
const PAGE_SIZES = [100, 30, 10, 1] as const;
const GATEWAY_ERRORS = new Set([502, 503, 504]);

/** Retry each page before reducing its size. A size change restarts at page 1:
 * page numbers are offsets relative to per_page, so mixing sizes loses jobs.
 * Nothing is returned until one complete pagination pass succeeds. */
export async function fetchAdaptiveJobsForRunAttempt(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  runAttempt: number,
  retry: Retry,
): Promise<GitHubRunJobsResponse> {
  for (const [sizeIndex, perPage] of PAGE_SIZES.entries()) {
    const jobs = new Map<number, GitHubJobPayload>();
    let page = 1;
    try {
      for (;; page += 1) {
        const context = `repo=${owner}/${repo} run=${runId} attempt=${runAttempt} jobs page=${page} per_page=${perPage}`;
        const pageJobs = await retry(async () => {
          const params = { owner, repo, run_id: runId, per_page: perPage, page };
          const response = runAttempt > 1
            ? await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
              ...params, attempt_number: runAttempt,
            })
            : await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', params);
          const data = response.data as { jobs?: unknown } | null;
          if (!Array.isArray(data?.jobs) || data.jobs.some(job =>
            !job || typeof job !== 'object' || !Number.isSafeInteger(job.id) || job.id < 0,
          )) {
            throw new InvalidJobsResponseError(`Invalid GitHub response: ${context} status=${response.status ?? 'unknown'} expected jobs array with numeric IDs`);
          }
          return data.jobs as GitHubJobPayload[];
        }, context);
        for (const job of pageJobs) jobs.set(job.id, job);
        if (pageJobs.length < perPage) return { jobs: [...jobs.values()] };
      }
    } catch (err) {
      const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
      if (!GATEWAY_ERRORS.has(status ?? 0) || sizeIndex === PAGE_SIZES.length - 1) throw err;
      console.warn(`Jobs pagination fallback: ${JSON.stringify({
        repo: `${owner}/${repo}`, runId, runAttempt, failedPage: page, status,
        previousPerPage: perPage, perPage: PAGE_SIZES[sizeIndex + 1], restartPage: 1,
      })}`);
    }
  }
  throw new Error('Jobs pagination exhausted without a complete response');
}
