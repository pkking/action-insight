import type { GitHubApiPayload, PullRequestRef } from '../../src/lib/types.ts';

/** Whether SQLite fallback/mirroring is explicitly enabled for ETL recovery runs. */
export function isSqliteFallbackEnabled(): boolean {
  return process.env.ENABLE_SQLITE_FALLBACK === '1' || process.env.ENABLE_SQLITE_FALLBACK === 'true';
}

/**
 * Run a Turso write first; on failure fall back to SQLite, and mirror to SQLite when
 * fallback is enabled. SQLite is only touched when `ENABLE_SQLITE_FALLBACK` is set;
 * otherwise a primary failure rethrows so operators see the outage.
 */
export async function writeWithOptionalSqliteFallback(
  primary: () => Promise<void>,
  fallback: () => Promise<void>,
  label: string,
  warn: (...args: unknown[]) => void,
): Promise<void> {
  try {
    await primary();
  } catch (err) {
    if (!isSqliteFallbackEnabled()) throw err;
    warn(`${label} Turso write failed, using SQLite fallback:`, err);
    await fallback();
    return;
  }

  if (isSqliteFallbackEnabled()) {
    await fallback();
  }
}

/**
 * Extract pull request references from a raw GitHub API run payload.
 * Returns an array of PullRequestRef objects for any valid entries.
 */
export function readPullRequestsFromPayload(payload: GitHubApiPayload | null): PullRequestRef[] {
  const pullRequests = payload?.['pull_requests'];
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
