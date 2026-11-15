import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTargetQuery,
  CLI_HELP,
  extractCanceller,
  loadAttemptsFileTargets,
  main,
  parseCliOptions,
  resolveTokenForRepo,
} from './collect-cancel-annotations';
import { getDatabaseClient } from '../../src/lib/db';
import { createOctokit, getGitHubIdentity, resolveGitHubTokens } from './github';

vi.mock('../../src/lib/db.ts', () => ({ getDatabaseClient: vi.fn() }));
vi.mock('./github.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>();
  return {
    ...actual,
    createOctokit: vi.fn(),
    resolveGitHubTokens: vi.fn(),
    getGitHubIdentity: vi.fn(),
  };
});

const TARGET_ROW = { run_id: 501, run_attempt: 1, runtime_seconds: 7200, head_sha: 'abcdef123456' };

function rateLimitError() {
  return Object.assign(new Error('API rate limit exceeded'), {
    status: 403,
    response: { headers: { 'x-ratelimit-remaining': '0' } },
  });
}

function notFoundError() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

interface DbFixture {
  targets?: Record<string, unknown>[];
  cancelledJobs?: Record<string, unknown>[];
  stats?: Record<string, unknown>;
  repos?: Record<string, unknown>[];
}

function setupDb(fixture: DbFixture = {}) {
  const updates: unknown[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.trimStart().startsWith('UPDATE workflow_attempts')) {
      updates.push(params ?? []);
      return { rows: [] };
    }
    if (sql.includes('SELECT id FROM repos')) return { rows: fixture.repos ?? [{ id: 1 }] };
    if (sql.includes('CREATE TEMP TABLE') || sql.includes('INSERT INTO cancel_targets')) return { rows: [] };
    if (sql.includes('COALESCE(SUM(LEAST')) {
      return { rows: [fixture.stats ?? { main_annotation_calls: 0, fallback_attempts: 0, attempts: 0 }] };
    }
    if (sql.includes('ORDER BY a.runtime_seconds DESC')) return { rows: fixture.targets ?? [] };
    if (sql.includes('SELECT job_id FROM workflow_jobs')) return { rows: fixture.cancelledJobs ?? [] };
    return { rows: [] };
  });
  vi.mocked(getDatabaseClient).mockResolvedValue({ query, release: vi.fn() } as never);
  return { updates, query };
}

function setupGitHub(request: (route: string, params?: Record<string, unknown>) => Promise<unknown>) {
  vi.mocked(resolveGitHubTokens).mockReturnValue(['token-a']);
  vi.mocked(getGitHubIdentity).mockResolvedValue('user:1 (tester)');
  vi.mocked(createOctokit).mockReturnValue({ request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
    if (route === 'GET /rate_limit') {
      return { data: { resources: { core: { remaining: 5000, reset: 1790000000 } } } };
    }
    return request(route, params);
  }) } as never);
}

function annotationsRoute(params?: Record<string, unknown>): boolean {
  return typeof params?.check_run_id === 'number' && String(params.per_page) === '100';
}

const HIT_ANNOTATION = [{ message: 'The run was canceled by @octocat.' }];

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI', () => {
  it('prints usage and exits 0 without touching the database or GitHub', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(CLI_HELP);
    expect(getDatabaseClient).not.toHaveBeenCalled();
    expect(createOctokit).not.toHaveBeenCalled();
  });

  it('rejects unknown options and non-positive limits', () => {
    expect(() => parseCliOptions(['--wat'])).toThrow('Unknown option: --wat');
    expect(() => parseCliOptions(['--limit', '0'])).toThrow('--limit requires a positive integer');
    expect(() => parseCliOptions(['--repo', 'norepo'])).toThrow('owner/repo');
    expect(parseCliOptions(['--dry-run', '--limit', '10', '--min-hours', '1.5', '-r', 'a/b'])).toEqual({
      repos: ['a/b'], attemptsFile: undefined, limit: 10, minHours: 1.5, maxApiCalls: undefined, dryRun: true, help: false,
    });
  });
});

describe('token resolution', () => {
  it('resolves per-repo secret first, then the shared fallback PAT, then rotating tokens', () => {
    const env = {
      GITHUB_TOKEN_PER_REPO_VLLM_PROJECT_VLLM_ASCEND: 'per-repo',
      GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND: 'fallback-pat',
    };
    expect(resolveTokenForRepo('vllm-project/vllm-ascend', ['t1', 't2'], 0, env)).toBe('per-repo');
    expect(resolveTokenForRepo('sgl-project/sglang', ['t1', 't2'], 0, env)).toBe('fallback-pat');
    expect(resolveTokenForRepo('a/b', ['t1', 't2'], 0, {})).toBe('t1');
    expect(resolveTokenForRepo('a/b', ['t1', 't2'], 1, {})).toBe('t2');
    expect(resolveTokenForRepo('a/b', ['t1', 't2'], 2, {})).toBe('t1');
    expect(resolveTokenForRepo('a/b', [], 0, {})).toBeUndefined();
  });
});

describe('annotation message parsing', () => {
  it('extracts the canceller from both spelling variants and keeps [bot] suffixes', () => {
    expect(extractCanceller('The run was canceled by @octocat.')).toBe('octocat');
    expect(extractCanceller('The run was cancelled by @alice-bot.')).toBe('alice-bot');
    expect(extractCanceller('The run was canceled by @github-actions[bot].')).toBe('github-actions[bot]');
    expect(extractCanceller('Other annotation without a canceller')).toBeNull();
    expect(extractCanceller('The run was canceled by @user, later retried')).toBeNull();
  });
});

describe('attempts file', () => {
  it('loads cancelled_unknown_attempts members keyed by repo and skips malformed entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-annotations-'));
    try {
      const file = path.join(dir, 'targets.json');
      fs.writeFileSync(file, JSON.stringify({
        cancelled_unknown_attempts: [
          { repo: 'a/b', run_id: 1, run_attempt: 1, runtime_seconds: 7200 },
          { repo: 'a/b', run_id: 2, run_attempt: 3 },
          { repo: 'c/d', run_id: 5, run_attempt: 1 },
          { repo: 'c/d', run_id: 5, run_attempt: 1 },
          { bad: true },
        ],
      }));
      const targets = loadAttemptsFileTargets(file);
      expect(targets.get('a/b')).toEqual(new Set(['1:1', '2:3']));
      expect(targets.get('c/d')).toEqual(new Set(['5:1']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses files without the cancelled_unknown_attempts key', () => {
    expect(() => loadAttemptsFileTargets('/nonexistent/file.json')).toThrow(/Cannot read attempts file|cancelled_unknown_attempts/);
  });
});

describe('target SQL', () => {
  it('keeps idempotency, membership filtering and runtime ordering in SQL', () => {
    const withFile = buildTargetQuery(true);
    expect(withFile).toContain('JOIN cancel_targets ct ON ct.run_id = a.run_id AND ct.run_attempt = a.run_attempt');
    expect(withFile).toContain('cancel_annotation_fetched_at IS NULL');
    expect(withFile).toContain("a.conclusion = 'cancelled'");
    expect(withFile).toContain('ORDER BY a.runtime_seconds DESC');
    expect(withFile).toContain('LIMIT $3');
    expect(buildTargetQuery(false)).not.toContain('cancel_targets');
  });
});

describe('probing', () => {
  it('probes cancelled jobs by runtime DESC, stops at the first hit and checkpoints the attempt', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [{ job_id: 111 }, { job_id: 222 }] });
    const request = vi.fn(async (_route: string, params?: Record<string, unknown>) => {
      if (annotationsRoute(params)) {
        if (params!.check_run_id === 111) return { data: HIT_ANNOTATION };
        throw new Error(`job 222 must not be probed after a hit`);
      }
      throw new Error(`unexpected route ${_route}`);
    });
    setupGitHub(request);

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    const annotationCalls = request.mock.calls.filter(([, params]) => annotationsRoute(params));
    expect(annotationCalls).toHaveLength(1);
    expect(annotationCalls[0]?.[1]).toMatchObject({ check_run_id: 111, page: 1 });
    expect(updates).toEqual([[
      501, 1, 'octocat', 'job_annotation',
      expect.stringContaining('canceled by @octocat'), expect.any(String),
    ]]);
  });

  it('falls back to head-sha check-runs when the attempt has no cancelled jobs', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [] });
    const request = vi.fn(async (_route: string, params?: Record<string, unknown>) => {
      if (String(_route).includes('/commits/')) {
        expect(params).toMatchObject({ ref: 'abcdef123456', filter: 'all' });
        return { data: { total_count: 1, check_runs: [{ id: 999, conclusion: 'cancelled', started_at: '2026-09-01T00:00:00Z' }] } };
      }
      if (annotationsRoute(params)) return { data: HIT_ANNOTATION };
      throw new Error(`unexpected route ${_route}`);
    });
    setupGitHub(request);

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    expect(updates).toEqual([[
      501, 1, 'octocat', 'check_run_annotation',
      expect.stringContaining('canceled by @octocat'), expect.any(String),
    ]]);
  });

  it('marks no_cancelled_check_run when the fallback finds no cancelled check run', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [] });
    setupGitHub(async (route, params) => {
      if (String(route).includes('/commits/')) return { data: { total_count: 0, check_runs: [] } };
      throw new Error(`unexpected route ${route} ${JSON.stringify(params)}`);
    });

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    expect(updates).toEqual([[501, 1, null, 'no_cancelled_check_run', null, expect.any(String)]]);
  });

  it('marks gone on 422 no-commit-for-SHA without retrying', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [] });
    setupGitHub(async (route, params) => {
      if (String(route).includes('/commits/')) {
        throw Object.assign(new Error('No commit found for SHA'), { status: 422 });
      }
      throw new Error(`unexpected route ${route} ${JSON.stringify(params)}`);
    });

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    expect(updates).toEqual([[501, 1, null, 'gone', null, expect.any(String)]]);
  });

  it('records gone on 404 without retrying and keeps the attempt idempotent-complete', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [{ job_id: 111 }] });
    const request = vi.fn(async (_route: string, params?: Record<string, unknown>) => {
      if (annotationsRoute(params)) throw notFoundError();
      throw new Error(`unexpected route ${_route}`);
    });
    setupGitHub(request);

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    const annotationCalls = request.mock.calls.filter(([, params]) => annotationsRoute(params));
    expect(annotationCalls).toHaveLength(1);
    expect(updates).toEqual([[501, 1, null, 'gone', null, expect.any(String)]]);
  });

  it('stops gracefully with exit code 3 on rate limit and writes no evidence', async () => {
    const { updates } = setupDb({ targets: [TARGET_ROW], cancelledJobs: [{ job_id: 111 }] });
    const request = vi.fn(async (_route: string, params?: Record<string, unknown>) => {
      if (annotationsRoute(params)) throw rateLimitError();
      throw new Error(`unexpected route ${_route}`);
    });
    setupGitHub(request);

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(3);
    expect(updates).toHaveLength(0);
  });

  it('makes zero GitHub calls when every candidate is already probed', async () => {
    const { updates } = setupDb({ targets: [] });
    const request = vi.fn(async () => { throw new Error('no API call expected'); });
    setupGitHub(request);

    const code = await main(['--repo', 'owner/repo']);
    expect(code).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('dry run prints per-repo estimates without API requests or DB writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-annotations-'));
    try {
      const file = path.join(dir, 'targets.json');
      fs.writeFileSync(file, JSON.stringify({
        cancelled_unknown_attempts: [{ repo: 'owner/repo', run_id: 501, run_attempt: 1 }],
      }));
      const { updates } = setupDb({
        targets: [TARGET_ROW],
        stats: { main_annotation_calls: 2, fallback_attempts: 1, attempts: 2 },
        repos: [{ id: 7 }],
      });
      const request = vi.fn(async () => { throw new Error('no API call expected in dry run'); });
      setupGitHub(request);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const code = await main(['--dry-run', '--attempts-file', file]);
      expect(code).toBe(0);
      expect(createOctokit).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      const printed = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
      expect(printed).toContain('Dry run');
      expect(printed).toContain('repo=owner/repo');
      // 2 annotation calls + 1 fallback attempt * 3 = 5
      expect(printed).toContain('estimatedApiCalls<=5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
