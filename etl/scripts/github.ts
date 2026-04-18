export interface GitHubRequestErrorLike {
  status: number;
  message: string;
  response?: {
    headers?: Record<string, string | number | undefined>;
    data?: { message?: string };
  };
}

export interface RateLimitDetails {
  limit?: string;
  remaining?: string;
  reset?: string;
}

export function getRateLimitDetails(error: GitHubRequestErrorLike): RateLimitDetails {
  return {
    limit: String(error.response?.headers?.['x-ratelimit-limit'] ?? ''),
    remaining: String(error.response?.headers?.['x-ratelimit-remaining'] ?? ''),
    reset: String(error.response?.headers?.['x-ratelimit-reset'] ?? ''),
  };
}

export function isGitHubRateLimitError(error: unknown): error is GitHubRequestErrorLike {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as GitHubRequestErrorLike;
  const message = `${candidate.message ?? ''} ${candidate.response?.data?.message ?? ''}`.toLowerCase();
  const { remaining } = getRateLimitDetails(candidate);
  const retryAfter = candidate.response?.headers?.['retry-after'];
  const hasSecondaryRateLimitSignal =
    message.includes('secondary rate limit') ||
    message.includes('abuse detection') ||
    message.includes('abuse rate limit') ||
    (Boolean(retryAfter) && candidate.status === 403);

  return (
    remaining === '0' ||
    message.includes('rate limit') ||
    message.includes('api rate limit exceeded') ||
    hasSecondaryRateLimitSignal
  );
}

export async function checkRateLimitBudget(
  octokit: { request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }> },
  requiredCalls: number
): Promise<{ ok: boolean; remaining: number; resetAt?: Date }> {
  try {
    const response = await octokit.request('GET /rate_limit');
    const data = response.data as { resources?: { core?: { remaining?: number; reset?: number } } };
    const remaining = data.resources?.core?.remaining ?? 0;
    const resetTimestamp = data.resources?.core?.reset;
    const resetAt = resetTimestamp ? new Date(resetTimestamp * 1000) : undefined;

    return {
      ok: remaining >= requiredCalls,
      remaining,
      resetAt,
    };
  } catch {
    return { ok: false, remaining: 0 };
  }
}
