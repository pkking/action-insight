import type { GitHubApiPayload, PullRequestRef } from '../../src/lib/types';

/**
 * Extract pull request references from a raw GitHub API run payload.
 * Returns an array of PullRequestRef objects for any valid entries.
 */
export function readPullRequestsFromPayload(payload: GitHubApiPayload | null): PullRequestRef[] {
  const pullRequests = payload?.pull_requests;
  if (!Array.isArray(pullRequests)) {
    return [];
  }

  return pullRequests
    .map((pullRequest) => {
      if (
        typeof pullRequest === 'object' &&
        pullRequest !== null &&
        typeof (pullRequest as { number?: unknown }).number === 'number'
      ) {
        return { number: (pullRequest as { number: number }).number };
      }

      return null;
    })
    .filter((pullRequest): pullRequest is PullRequestRef => pullRequest !== null);
}
