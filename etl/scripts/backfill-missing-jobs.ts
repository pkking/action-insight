import { Octokit } from '@octokit/core';
import { format, subDays } from 'date-fns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOctokit } from './github';

import { getDatabaseClient } from '../../src/lib/db.ts';
import { writeWorkflowAttempts } from './pg-storage.ts';
import { toPgSql, pgPlaceholders } from './pg-utils.ts';
import { buildWorkflowAttempts, enrichRunWithWorkflowMetadata } from './workflow-attempts.ts';
import { parseReposConfig, type RepoConfigEntry, type ReposConfig } from './repos-config.ts';
import type { Run, Step } from '../../src/lib/types.ts';

interface MissingAttemptRow {
  run_id: number;
  run_attempt: number;
  name: string;
  head_branch: string;
  head_sha: string | null;
  status: string;
  conclusion: string | null;
  event: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  duration_seconds: number | null;
  workflow_path: string | null;
  workflow_parse_status: string | null;
  run_started_at: string | null;
}

interface JobRow {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  queue_duration_seconds: number | null;
  duration_seconds: number | null;
  labels?: string[];
  runner_id?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  resource_model?: string;
  resource_count?: number;
  steps?: Step[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JOBS_PER_PAGE = 100;

function warn(...args: unknown[]) {
  console.warn(`[${new Date().toISOString()}] WARN:`, ...args);
}

function parseRunnerResourceLabels(labels?: string[]): Pick<JobRow, 'resource_model' | 'resource_count'> {
  for (const label of labels ?? []) {
    const match = /^linux-aarch64-(.+)-([1-9]\d*)$/.exec(label);
    if (match) return { resource_model: `linux-aarch64-${match[1]}`, resource_count: Number(match[2]) };
  }
  return {};
}

function readReposConfig(): ReposConfig {
  const reposConfigPath = path.join(__dirname, '../repos.yaml');
  const content = fs.readFileSync(reposConfigPath, 'utf8');
  return parseReposConfig(content);
}

function findRepoConfig(config: ReposConfig, repo: string): RepoConfigEntry {
  return config.repos.find((entry) => entry.repo === repo) ?? { repo, workflows: [] };
}

function parseArgs(argv: string[]): { repos: string[]; days: number; help: boolean } {
  const repos: string[] = [];
  let days = 14;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--repo' || arg === '-r') {
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires an owner/repo value`);
      }
      repos.push(next);
      index += 1;
      continue;
    }

    if (arg === '--days') {
      if (!next || next.startsWith('-')) {
        throw new Error('--days requires an integer value');
      }
      days = Number(next);
      if (!Number.isInteger(days) || days <= 0) {
        throw new Error('--days must be a positive integer');
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    repos,
    days,
    help,
  };
}

function formatHelp(): string {
  return `
Usage: npx tsx etl/scripts/backfill-missing-jobs.ts [options]

Backfill jobs for tracked workflow attempts that already exist in SQLite but have no jobs stored yet.

Options:
  --repo, -r <owner/repo>   Backfill one repo. Can be repeated.
  --days <n>                Limit to attempts created in the last n days (default: 14)
  --help, -h                Show this help.
`.trim();
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
      const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
      const transient =
        (typeof status === 'number' && status >= 500 && status < 600) ||
        (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_SOCKET_TIMEOUT'].includes(code));

      if (!transient || attempt === maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * 2 ** attempt;
      warn(`Transient API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`, err);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

async function fetchJobsForRunAttempt(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  runAttempt: number,
): Promise<JobRow[]> {
  const jobs: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page += 1) {
    const response = await withRetry(async () => {
      try {
        if (runAttempt > 1) {
          return await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
            owner,
            repo,
            run_id: runId,
            attempt_number: runAttempt,
            per_page: JOBS_PER_PAGE,
            page,
          });
        }

        return await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
          owner,
          repo,
          run_id: runId,
          per_page: JOBS_PER_PAGE,
          page,
        });
      } catch (err) {
        const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
        if (status === 404 || status === 422) {
          warn(`Skipping run ${repo}#${runId} attempt ${runAttempt} because GitHub returned ${status}`);
          return { data: { jobs: [] } };
        }
        throw err;
      }
    });
    const pageJobs = (response.data as { jobs?: Array<Record<string, unknown>> }).jobs ?? [];
    jobs.push(...pageJobs);
    if (pageJobs.length < JOBS_PER_PAGE) break;
  }
  return jobs.map((job) => {
    const rawSteps = Array.isArray(job.steps) ? job.steps as Array<Record<string, unknown>> : [];
    const steps: Step[] = rawSteps.map((step, index) => ({
      number: typeof step.number === 'number' ? step.number : index + 1,
      name: typeof step.name === 'string' ? step.name : `Step ${index + 1}`,
      status: typeof step.status === 'string' ? step.status : 'unknown',
      conclusion: typeof step.conclusion === 'string' ? step.conclusion : 'unknown',
      started_at: typeof step.started_at === 'string' ? step.started_at : undefined,
      completed_at: typeof step.completed_at === 'string' ? step.completed_at : undefined,
      duration_seconds: 0,
    }));

    const labels = Array.isArray(job.labels) && job.labels.every((label): label is string => typeof label === 'string')
      ? job.labels
      : undefined;

    return {
      id: Number(job.id),
      name: typeof job.name === 'string' ? job.name : 'unknown',
      status: typeof job.status === 'string' ? job.status : 'unknown',
      conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
      created_at: typeof job.created_at === 'string' ? job.created_at : null,
      started_at: typeof job.started_at === 'string' ? job.started_at : null,
      completed_at: typeof job.completed_at === 'string' ? job.completed_at : null,
      html_url: typeof job.html_url === 'string' ? job.html_url : null,
      queue_duration_seconds: null,
      duration_seconds: null,
      labels,
      runner_id: typeof job.runner_id === 'number' ? job.runner_id : undefined,
      runner_name: typeof job.runner_name === 'string' ? job.runner_name : undefined,
      runner_group_id: typeof job.runner_group_id === 'number' ? job.runner_group_id : undefined,
      runner_group_name: typeof job.runner_group_name === 'string' ? job.runner_group_name : undefined,
      ...parseRunnerResourceLabels(labels),
      steps,
    };
  });
}

async function fetchMissingAttempts(
  repo: string,
  days: number,
): Promise<MissingAttemptRow[]> {
  const client = await getDatabaseClient();
  try {
  const [owner, repoName] = repo.split('/');
  const sinceDate = format(subDays(new Date(), days), 'yyyy-MM-dd');

  const { rows: repoRows } = await client.query(
    `SELECT id FROM repos WHERE owner = $1 AND repo = $2`,
    [owner, repoName],
  );

  if (repoRows.length === 0) return [];
  const repoId = Number(repoRows[0].id);

  const { rows } = await client.query(
    toPgSql(`SELECT r.id AS run_id,
                 wa.run_attempt,
                 r.name,
                 r.head_branch,
                 r.head_sha,
                 r.status,
                 r.conclusion,
                 r.event,
                 r.created_at,
                 r.updated_at,
                 r.html_url,
                 r.duration_seconds,
                 r.workflow_path,
                 r.workflow_parse_status,
                 wa.run_started_at
          FROM workflow_attempts wa
          JOIN runs r ON r.id = wa.run_id
          WHERE r.repo_id = ?
            AND wa.tracked = 1
            AND date(r.created_at) >= date(?)
            AND NOT EXISTS (
              SELECT 1
              FROM workflow_jobs wj
              WHERE wj.run_id = wa.run_id
                AND wj.run_attempt = wa.run_attempt
            )
          ORDER BY r.created_at DESC, wa.run_id DESC, wa.run_attempt DESC`),
    [repoId, sinceDate],
  );

  return rows.map((row) => ({
    run_id: Number(row.run_id),
    run_attempt: Number(row.run_attempt),
    name: String(row.name ?? 'unknown'),
    head_branch: String(row.head_branch ?? 'unknown'),
    head_sha: typeof row.head_sha === 'string' ? row.head_sha : null,
    status: String(row.status ?? 'unknown'),
    conclusion: typeof row.conclusion === 'string' ? row.conclusion : null,
    event: typeof row.event === 'string' ? row.event : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    html_url: String(row.html_url ?? ''),
    duration_seconds: typeof row.duration_seconds === 'number' ? row.duration_seconds : null,
    workflow_path: typeof row.workflow_path === 'string' ? row.workflow_path : null,
    workflow_parse_status: typeof row.workflow_parse_status === 'string' ? row.workflow_parse_status : null,
    run_started_at: typeof row.run_started_at === 'string' ? row.run_started_at : null,
  }));
  } finally {
    client.release();
  }
}

async function backfillRepo(repo: string, config: ReposConfig, days: number): Promise<void> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  }

  const repoConfig = findRepoConfig(config, repo);
  const missingAttempts = await fetchMissingAttempts(repo, days);
  console.log(`${repo}: ${missingAttempts.length} missing workflow attempts in the last ${days} day(s)`);

  if (missingAttempts.length === 0) {
    return;
  }

  const octokit = createOctokit(process.env.GITHUB_TOKEN);
  let completed = 0;

  for (const attempt of missingAttempts) {
    const jobs = await fetchJobsForRunAttempt(octokit, owner, repoName, attempt.run_id, attempt.run_attempt);
    const run: Run = {
      id: attempt.run_id,
      runAttempt: attempt.run_attempt,
      name: attempt.name,
      head_branch: attempt.head_branch,
      head_sha: attempt.head_sha ?? undefined,
      status: attempt.status,
      conclusion: attempt.conclusion ?? '',
      event: attempt.event ?? undefined,
      created_at: attempt.created_at,
      updated_at: attempt.updated_at,
      html_url: attempt.html_url,
      durationInSeconds: attempt.duration_seconds ?? Math.max(0, (Date.parse(attempt.updated_at) - Date.parse(attempt.created_at)) / 1000),
      pull_requests: [],
      jobs,
      workflowPath: attempt.workflow_path ?? undefined,
      workflowParseStatus: (attempt.workflow_parse_status as Run['workflowParseStatus']) ?? undefined,
      run_started_at: attempt.run_started_at ?? undefined,
    };

    const enriched = enrichRunWithWorkflowMetadata(run, config, repoConfig);
    const attempts = buildWorkflowAttempts([enriched], config, repoConfig);
    await writeWorkflowAttempts(repo, attempts);

    completed += 1;
    if (completed % 25 === 0 || completed === missingAttempts.length) {
      console.log(`${repo}: backfilled ${completed}/${missingAttempts.length} missing attempts`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatHelp());
    return;
  }

  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const config = readReposConfig();
  const targetRepos = args.repos.length > 0 ? args.repos : config.repos.map((entry) => entry.repo);

  for (const repo of targetRepos) {
    await backfillRepo(repo, config, args.days);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
