import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Octokit } from '@octokit/core';
import { createClient, type Client } from '@libsql/client';
import { addDays, format, parseISO } from 'date-fns';
import yaml from 'js-yaml';

import { rebuildPullRequestArtifacts } from './pr-artifacts.ts';
import { getCollectedDatesFromTurso, checkEtlFreshness, formatFreshnessReport } from './turso-storage.ts';
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

async function fetchRunsFromTurso(repo: string, dates: string[]): Promise<Run[]> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const client = createClient({ url, authToken });
  const [owner, repoName] = repo.split('/');

  const { rows: repoRows } = await client.execute({
    sql: `SELECT id FROM repos WHERE owner = ? AND repo = ?`,
    args: [owner, repoName],
  });

  if (repoRows.length === 0) {
    console.warn(`Repo ${repo} not found in Turso`);
    return [];
  }

  const repoId = Number(repoRows[0].id);
  const allRuns: Run[] = [];
  const runMap = new Map<number, Run>();

  for (const date of dates) {
    let dateRunCount = 0;
    let offset = 0;

    while (true) {
      const { rows } = await client.execute({
        sql: `SELECT r.id, r.name, r.head_branch, r.head_sha, r.status, r.conclusion,
                     r.event, r.created_at, r.updated_at, r.html_url, r.duration_seconds, r.date,
                     j.id AS job_id, j.name AS job_name, j.status AS job_status,
                     j.conclusion AS job_conclusion, j.created_at AS job_created_at,
                     j.started_at AS job_started_at, j.completed_at AS job_completed_at,
                     j.html_url AS job_html_url,
                     j.queue_duration_seconds, j.duration_seconds AS job_duration_seconds
              FROM runs r
              LEFT JOIN jobs j ON j.run_id = r.id
              WHERE r.repo_id = ? AND r.date = ?
              ORDER BY r.created_at DESC, r.id DESC, j.started_at ASC
              LIMIT ? OFFSET ?`,
        args: [repoId, date, RUN_SELECT_PAGE_SIZE, offset],
      });

      if (rows.length === 0 && offset === 0) {
        break;
      }

      for (const row of rows) {
        const runId = Number(row.id);
        if (!runMap.has(runId)) {
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
            jobs: [],
          };
          runMap.set(runId, run);
          allRuns.push(run);
          dateRunCount += 1;
        }
        if (row.job_id != null) {
          const run = runMap.get(runId)!;
          run.jobs.push({
            id: Number(row.job_id),
            name: row.job_name as string,
            status: row.job_status as string,
            conclusion: (row.job_conclusion as string) || '',
            created_at: row.job_created_at as string,
            started_at: row.job_started_at as string,
            completed_at: row.job_completed_at as string,
            html_url: row.job_html_url as string,
            queueDurationInSeconds: Number(row.queue_duration_seconds),
            durationInSeconds: Number(row.job_duration_seconds),
          });
        }
      }

      if (rows.length < RUN_SELECT_PAGE_SIZE) {
        break;
      }

      offset += RUN_SELECT_PAGE_SIZE;
    }

    console.log(`Fetched ${dateRunCount} runs for ${repo} on ${date}`);
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
      const collectedDates = await getCollectedDatesFromTurso(repoKey);
      const dates = selectDates(collectedDates, options);
      if (dates.length === 0) {
        console.warn(`Skipping ${repoKey}: no collected dates matched the selected range`);
        continue;
      }

      console.log(`Rebuilding PR artifacts for ${repoKey} from ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} date(s))`);
      const runs = await fetchRunsFromTurso(repoKey, dates);
      const token = resolveGitHubToken(repoKey);
      const octokit = token ? new Octokit({ auth: token }) : undefined;
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
      failures.push(`${repoKey}: ${message}`);
      console.error(`Error rebuilding PR artifacts for ${repoKey}:`, message);
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
