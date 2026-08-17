import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOctokit } from './github';
import { addDays, format, parseISO } from 'date-fns';
import yaml from 'js-yaml';

import { rebuildPullRequestArtifacts } from './pr-artifacts.ts';
import { getCollectedDates, checkEtlFreshness, formatFreshnessReport } from './pg-storage.ts';
import { getDatabaseClient } from '../../src/lib/db.ts';
import { toPgSql, pgPlaceholders } from './pg-utils.ts';
import type { PoolClient } from 'pg';
import type { Run } from '../../src/lib/types.ts';

interface ReposConfig {
  repos?: unknown;
}

interface RebuildCliOptions {
  repos: string[];
  startDate?: string;
  endDate?: string;
  help: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUN_SELECT_PAGE_SIZE = 1000;

/** Resolve the GitHub token for a given repo.
 * Priority: per-repo env var (GITHUB_TOKEN_PER_REPO_...) → fallback PAT (triton-lang/triton-ascend).
 * The fallback token ensures newly added repos work even before their dedicated token is configured.
 * Example: vllm-project/vllm-ascend → GITHUB_TOKEN_PER_REPO_VLLM_PROJECT_VLLM_ASCEND */
function resolveGitHubToken(repoKey: string): string | undefined {
  const perRepoKey = `GITHUB_TOKEN_PER_REPO_${repoKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[perRepoKey] ?? process.env.GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND;
}

const CLI_HELP = `Usage: npx tsx etl/scripts/rebuild-pr-artifacts.ts [options]

Rebuild PR metrics and PR workflow links from raw runs already stored in Turso.

Options:
  --repo, -r <owner/repo>     Rebuild one repo. Can be repeated.
  --start-date <yyyy-mm-dd>   Include runs on or after this date.
  --end-date <yyyy-mm-dd>     Include runs on or before this date.
  --help, -h                  Show this help.

Examples:
  npx tsx etl/scripts/rebuild-pr-artifacts.ts --repo vllm-project/vllm-ascend
  npx tsx etl/scripts/rebuild-pr-artifacts.ts --repo vllm-project/vllm-ascend --start-date 2026-05-01 --end-date 2026-05-24
`;

function readReposConfig(): string[] {
  const reposConfigPath = path.join(__dirname, '../repos.yaml');
  if (!fs.existsSync(reposConfigPath)) {
    return [];
  }

  const content = fs.readFileSync(reposConfigPath, 'utf8');
  const config = yaml.load(content) as ReposConfig | null;

  return Array.isArray(config?.repos) ? config.repos.filter((entry): entry is string => typeof entry === 'string') : [];
}

function assertDate(value: string, optionName: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${optionName} must use yyyy-mm-dd format`);
  }

  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime()) || format(parsed, 'yyyy-MM-dd') !== value) {
    throw new Error(`${optionName} is not a valid date: ${value}`);
  }

  return value;
}

function parseCliOptions(argv: string[]): RebuildCliOptions {
  const repos: string[] = [];
  let startDate: string | undefined;
  let endDate: string | undefined;
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

    if (arg === '--start-date') {
      if (!next || next.startsWith('-')) {
        throw new Error('--start-date requires a yyyy-mm-dd value');
      }
      startDate = assertDate(next, '--start-date');
      index += 1;
      continue;
    }

    if (arg === '--end-date') {
      if (!next || next.startsWith('-')) {
        throw new Error('--end-date requires a yyyy-mm-dd value');
      }
      endDate = assertDate(next, '--end-date');
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (startDate && endDate && startDate > endDate) {
    throw new Error('--start-date must be on or before --end-date');
  }

  return {
    repos: repos.length > 0 ? repos : readReposConfig(),
    startDate,
    endDate,
    help,
  };
}

function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = parseISO(startDate);
  const end = parseISO(endDate);

  while (cursor <= end) {
    dates.push(format(cursor, 'yyyy-MM-dd'));
    cursor = addDays(cursor, 1);
  }

  return dates;
}

function selectDates(collectedDates: string[], options: RebuildCliOptions): string[] {
  const normalizedDates = Array.from(new Set(collectedDates.map((date) => date.slice(0, 10)))).sort();

  if (options.startDate && options.endDate) {
    return buildDateRange(options.startDate, options.endDate);
  }

  return normalizedDates.filter((date) => {
    if (options.startDate && date < options.startDate) return false;
    if (options.endDate && date > options.endDate) return false;
    return true;
  });
}

async function fetchRunsFromDatabase(repo: string, dates: string[]): Promise<Run[]> {
  const client = await getDatabaseClient();
  if (!client) {
    throw new Error('Database is not configured for PR artifact rebuild (set PG_DATABASE_URL)');
  }
  try {
    return await fetchRunsFromClient(client, repo, dates, 'PG');
  } finally {
    client.release();
  }
}

async function fetchRunsFromClient(client: PoolClient, repo: string, dates: string[], label: string): Promise<Run[]> {
  const [owner, repoName] = repo.split('/');

  const { rows: repoRows } = await client.query(
    `SELECT id FROM repos WHERE owner = $1 AND repo = $2`,
    [owner, repoName],
  );

  if (repoRows.length === 0) {
    console.warn(`Repo ${repo} not found in ${label}`);
    return [];
  }

  const repoId = Number(repoRows[0].id);
  const allRuns: Run[] = [];

  for (const date of dates) {
    const attemptRuns = await fetchWorkflowAttemptRunsFromClient(client, repoId, [date]);
    if (attemptRuns.length > 0) {
      console.log(`Fetched ${attemptRuns.length} tracked workflow attempts for ${repo} on ${date} from ${label}`);
      allRuns.push(...attemptRuns);
      continue;
    }

    let dateRunCount = 0;
    let offset = 0;

    while (true) {
      // Step 1: Paginate runs only
	      const { rows: runRows } = await client.query(
	        `SELECT id, name, head_branch, head_sha, status, conclusion,
	                     event, created_at, updated_at, html_url, duration_seconds, date,
	                     workflow_file, workflow_ref, workflow_path, workflow_parse_status
	              FROM runs
              WHERE repo_id = $1 AND date = $2
              ORDER BY created_at DESC, id DESC
              LIMIT $3 OFFSET $4`,
        [repoId, date, RUN_SELECT_PAGE_SIZE, offset],
      );

      if (runRows.length === 0 && offset === 0) {
        break;
      }

      const runIds = runRows.map((r) => r.id as number);

      // Step 2: Batch-fetch jobs for these runs
      if (runIds.length > 0) {
        const placeholders = pgPlaceholders(runIds.length);
        const { rows: jobRows } = await client.query(
          `SELECT id, run_id, name, status, conclusion, created_at, started_at,
                       completed_at, html_url, queue_duration_seconds, duration_seconds
                FROM jobs WHERE run_id IN (${placeholders})
                ORDER BY run_id, started_at ASC`,
          runIds,
        );

        const jobsByRun = new Map<number, Array<Record<string, unknown>>>();
        for (const j of jobRows) {
          const rid = Number(j.run_id);
          if (!jobsByRun.has(rid)) jobsByRun.set(rid, []);
          jobsByRun.get(rid)!.push(j);
        }

        for (const row of runRows) {
          const runId = Number(row.id);
          const run: Run = {
            id: runId,
            name: row.name as string,
            head_branch: row.head_branch as string,
            head_sha: row.head_sha as string | undefined,
            status: row.status as string,
            conclusion: (row.conclusion as string) || '',
            event: row.event as string | undefined,
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
            html_url: row.html_url as string,
	            durationInSeconds: Number(row.duration_seconds),
	            workflowFile: row.workflow_file as string | undefined,
	            workflowRef: row.workflow_ref as string | undefined,
	            workflowPath: row.workflow_path as string | undefined,
	            workflowParseStatus: row.workflow_parse_status as Run['workflowParseStatus'],
	            jobs: (jobsByRun.get(runId) || []).map((j) => ({
              id: Number(j.id),
              name: j.name as string,
              status: j.status as string,
              conclusion: (j.conclusion as string) || '',
              created_at: j.created_at as string,
              started_at: j.started_at as string,
              completed_at: j.completed_at as string,
              html_url: j.html_url as string,
              queueDurationInSeconds: Number(j.queue_duration_seconds),
              durationInSeconds: Number(j.duration_seconds),
            })),
          };
          allRuns.push(run);
          dateRunCount += 1;
        }
      }

      if (runRows.length < RUN_SELECT_PAGE_SIZE) {
        break;
      }

      offset += RUN_SELECT_PAGE_SIZE;
    }

    console.log(`Fetched ${dateRunCount} runs for ${repo} on ${date} from ${label}`);
  }

  return allRuns;
}

async function fetchWorkflowAttemptRunsFromClient(client: PoolClient, repoId: number, dates: string[]): Promise<Run[]> {
  const allRuns: Run[] = [];
  for (const date of dates) {
    const { rows } = await client.query(
      `SELECT r.id, r.name, r.head_branch, r.head_sha, r.event, r.html_url,
                   r.workflow_path, r.workflow_parse_status,
                   wa.run_attempt, wa.status, wa.conclusion, wa.created_at, wa.run_started_at,
                   wa.completed_at, wa.updated_at, wa.queue_duration_seconds,
                   wa.runtime_seconds, wa.total_duration_seconds, wa.workflow_file,
                   wa.workflow_ref, wa.match_kind, wa.step_policy_hash
            FROM workflow_attempts wa
            JOIN runs r ON r.id = wa.run_id
            WHERE r.repo_id = $1 AND r.date = $2 AND wa.tracked = 1
            ORDER BY wa.created_at DESC, wa.run_id DESC, wa.run_attempt DESC`,
      [repoId, date],
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('does not exist')) {
        return { rows: [] };
      }
      throw error;
    });

    if (rows.length === 0) continue;

    const attemptKeys = rows.map((row) => ({
      runId: Number(row.id),
      runAttempt: Number(row.run_attempt),
    }));

    // ponytail: chunk to stay below SQLite's 999-variable limit (100 keys = 200 vars).
    const jobRows: Record<string, unknown>[] = [];
    const chunkSize = 100;
    for (let i = 0; i < attemptKeys.length; i += chunkSize) {
      const chunk = attemptKeys.slice(i, i + chunkSize);
      const clauses = chunk.map((_, idx) => `(run_id = $${idx * 2 + 1} AND run_attempt = $${idx * 2 + 2})`).join(' OR ');
      const chunkRows = await client.query(
          `SELECT run_id, run_attempt, job_id, name, status, conclusion, created_at,
                       started_at, completed_at, html_url, queue_duration_seconds,
                       runtime_seconds, total_duration_seconds, duration_seconds
                FROM workflow_jobs
                WHERE ${clauses}
                ORDER BY run_id, run_attempt, started_at ASC`,
          chunk.flatMap((key) => [key.runId, key.runAttempt]),
        ).then((result) => result.rows).catch(() => []);
      jobRows.push(...chunkRows);
    }

    const jobsByAttempt = new Map<string, Array<Record<string, unknown>>>();
    for (const job of jobRows) {
      const key = `${Number(job.run_id)}:${Number(job.run_attempt)}`;
      if (!jobsByAttempt.has(key)) jobsByAttempt.set(key, []);
      jobsByAttempt.get(key)!.push(job as Record<string, unknown>);
    }

    for (const row of rows) {
      const runId = Number(row.id);
      const runAttempt = Number(row.run_attempt);
      allRuns.push({
        id: runId,
        runAttempt,
        name: row.name as string,
        head_branch: row.head_branch as string,
        head_sha: row.head_sha as string | undefined,
        status: row.status as string,
        conclusion: (row.conclusion as string) || '',
        event: row.event as string | undefined,
        created_at: row.created_at as string,
        run_started_at: row.run_started_at as string | undefined,
        updated_at: (row.completed_at as string) || (row.updated_at as string),
        html_url: row.html_url as string,
        durationInSeconds: Number(row.total_duration_seconds ?? row.runtime_seconds ?? 0),
        queueDurationInSeconds: row.queue_duration_seconds == null ? undefined : Number(row.queue_duration_seconds),
        runtimeInSeconds: row.runtime_seconds == null ? undefined : Number(row.runtime_seconds),
        workflowFile: row.workflow_file as string | undefined,
        workflowRef: row.workflow_ref as string | undefined,
        workflowPath: row.workflow_path as string | undefined,
        workflowParseStatus: row.workflow_parse_status as Run['workflowParseStatus'],
        workflowMatchKind: row.match_kind as Run['workflowMatchKind'],
        stepPolicyHash: row.step_policy_hash as string | undefined,
        tracked: true,
        jobs: (jobsByAttempt.get(`${runId}:${runAttempt}`) ?? []).map((job) => ({
          id: Number(job.job_id),
          runAttempt,
          name: job.name as string,
          status: job.status as string,
          conclusion: (job.conclusion as string) || '',
          created_at: job.created_at as string,
          started_at: job.started_at as string,
          completed_at: job.completed_at as string,
          html_url: job.html_url as string,
          queueDurationInSeconds: Number(job.queue_duration_seconds ?? 0),
          durationInSeconds: Number(job.runtime_seconds ?? job.duration_seconds ?? 0),
          runtimeInSeconds: job.runtime_seconds == null ? undefined : Number(job.runtime_seconds),
          totalDurationInSeconds: job.total_duration_seconds == null ? undefined : Number(job.total_duration_seconds),
        })),
      });
    }
  }
  return allRuns;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);

  if (options.help) {
    console.log(CLI_HELP);
    return;
  }

  if (options.repos.length === 0) {
    console.warn('No repositories found to process. Use --repo <owner/repo> or check etl/repos.yaml.');
    return;
  }

  const failures: string[] = [];

  for (const repoKey of options.repos) {
    const [owner, repo] = repoKey.split('/');
    if (!owner || !repo) {
      console.warn(`Skipping invalid repo key: ${repoKey}`);
      continue;
    }

    try {
      const collectedDates = await getCollectedDates(repoKey);
      const dates = selectDates(collectedDates, options);
      if (dates.length === 0) {
        console.warn(`Skipping ${repoKey}: no collected dates matched the selected range`);
        continue;
      }

      console.log(`Rebuilding PR artifacts for ${repoKey} from ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} date(s))`);
      const runs = await fetchRunsFromDatabase(repoKey, dates);
      const token = resolveGitHubToken(repoKey);
      const octokit = token ? createOctokit(token) : undefined;
      if (!octokit) {
        console.warn('No GitHub token is configured; PR metrics rebuild will only use cached or embedded PR associations.');
      }

      await rebuildPullRequestArtifacts({
        octokit,
        owner,
        repo,
        repoKey,
        collectedDates: dates,
        runs,
        log: (...args: unknown[]) => console.log(...args),
        warn: (...args: unknown[]) => console.warn(...args),
      });

      console.log(`Rebuilt PR artifacts for ${repoKey} from ${runs.length} raw run(s)`);

      const freshness = await checkEtlFreshness(repoKey);
      if (freshness) {
        const message = formatFreshnessReport(freshness, repoKey);
        if (freshness.isStale) {
          console.warn(message);
        } else {
          console.log(message);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      failures.push(`${repoKey}: ${message}`);
      console.error(`Error rebuilding PR artifacts for ${repoKey}:`, message);
      console.error(stack);
    }
  }

  if (failures.length > 0) {
    console.error('PR artifact rebuild completed with failures:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    throw new Error(`PR artifact rebuild failed for ${failures.length} repo(s)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
