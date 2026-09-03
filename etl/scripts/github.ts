import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Octokit } from '@octokit/core';

/**
 * Resolve local GitHub credentials without exposing token values in logs.
 * The checked-in CI path may still provide GITHUB_TOKEN; local ETL prefers a
 * user-supplied token file and the authenticated GitHub CLI token.
 */
export function resolveGitHubTokens({
  cwd = process.cwd(),
  env = process.env,
  readFile = fs.readFileSync,
  ghAuthToken = () => execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
}: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: typeof fs.readFileSync;
  ghAuthToken?: () => string;
} = {}): string[] {
  const tokens: string[] = [];
  const add = (value?: string) => {
    const token = value?.trim();
    if (token && !tokens.includes(token)) tokens.push(token);
  };

  const tokenFile = env.GITHUB_TOKEN_FILE ?? path.join(cwd, 'gh-token.txt');
  try {
    add(readFile(tokenFile, 'utf8').toString());
  } catch {
    // Token file is optional; gh auth or CI env can provide credentials.
  }
  try {
    add(ghAuthToken());
  } catch {
    // GitHub CLI authentication is optional.
  }
  add(env.GITHUB_TOKEN);
  return tokens;
}

/** Default per-request timeout for GitHub API calls (ms).
 * Guards against hung TCP connections that would otherwise block the serial
 * SHA→PR resolution loop indefinitely. 30s is generous; GitHub API calls
 * normally complete in <1s, so 30s of silence means the socket is dead. */
const GITHUB_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.GITHUB_REQUEST_TIMEOUT_MS ?? '30000', 10);

/** Wrap the global fetch with an AbortController-based timeout.
 * Returns a fetch compatible with Octokit's `request.fetch` option. */
function fetchWithTimeout(): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

/** Create an Octokit client with a per-request timeout.
 * The timeout ensures hung GitHub connections abort (throwing a request error
 * that callers catch and treat as retryable) instead of blocking serial loops
 * forever — e.g. the PR SHA-resolution loop in pr-artifacts.ts. */
export function createOctokit(token?: string): Octokit {
  return new Octokit({ auth: token, request: { fetch: fetchWithTimeout() } });
}

/** GitHub core limits are shared by an authenticated identity, not a token string. */
export async function getGitHubIdentity(octokit: Octokit): Promise<string> {
  const response = await octokit.request('GET /user');
  const data = response.data as { id?: number; login?: string };
  if (typeof data.id !== 'number') throw new Error('GitHub identity response did not include an id');
  return `user:${data.id}${data.login ? ` (${data.login})` : ''}`;
}

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
  retryAfter?: string;
}

export function getRateLimitDetails(error: GitHubRequestErrorLike): RateLimitDetails {
  return {
    limit: String(error.response?.headers?.['x-ratelimit-limit'] ?? ''),
    remaining: String(error.response?.headers?.['x-ratelimit-remaining'] ?? ''),
    reset: String(error.response?.headers?.['x-ratelimit-reset'] ?? ''),
    retryAfter: String(error.response?.headers?.['retry-after'] ?? ''),
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
