// Benchmark runner and reporting for 3-day historical collection snapshots
import { Octokit } from '@octokit/core';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import collectionWindows, { type CollectionWindow } from '../../src/lib/collection-windows.ts';
import {
  type CollectCliOptions,
} from './collect-options.ts';
import { collectRepo } from './collect.ts';
import { createOctokit, resolveGitHubTokens } from './github.ts';
import { getDatabaseClient } from '../../src/lib/db.ts';
import { ensureRepo } from './pg-storage.ts';
import { getRepoNames, parseReposConfig, type ReposConfig } from './repos-config.ts';

const { buildCollectionWindows } = collectionWindows;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function queryRepoEntityCounts(repo: string): Promise<{
  runs: number;
  attempts: number;
  jobs: number;
  steps: number;
}> {
  const client = await getDatabaseClient();
  if (!client) return { runs: 0, attempts: 0, jobs: 0, steps: 0 };
  try {
    const [owner, repoName] = repo.split('/');
    const repoId = await ensureRepo(client, owner, repoName);
    const { rows } = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM runs WHERE repo_id = $1) as runs,
        (SELECT COUNT(*) FROM workflow_attempts wa JOIN runs r ON wa.run_id = r.id WHERE r.repo_id = $1) as attempts,
        (SELECT COUNT(*) FROM workflow_jobs wj JOIN runs r ON wj.run_id = r.id WHERE r.repo_id = $1) as jobs,
        (SELECT COUNT(*) FROM workflow_steps ws JOIN runs r ON ws.run_id = r.id WHERE r.repo_id = $1) as steps;
    `, [repoId]);
    return {
      runs: Number(rows[0]?.runs ?? 0),
      attempts: Number(rows[0]?.attempts ?? 0),
      jobs: Number(rows[0]?.jobs ?? 0),
      steps: Number(rows[0]?.steps ?? 0),
    };
  } catch {
    return { runs: 0, attempts: 0, jobs: 0, steps: 0 };
  } finally {
    client.release();
  }
}

export interface RequestAccounting {
  listRequests: number;
  jobsRequests: number;
  rerunJobsRequests: number;
  conditional304s: number;
  otherRequests: number;
  totalRequests: number;
  totalRequestElapsedMs: number;
}

export interface CollectionMetrics {
  requests: RequestAccounting;
  wallClockMs: number;
  runs: number;
  attempts: number;
  jobs: number;
  steps: number;
}

export interface BenchmarkComparison {
  repo: string;
  sizeCategory?: 'small' | 'medium' | 'high' | 'all' | 'other';
  cold: CollectionMetrics;
  warm: CollectionMetrics;
  requestReductionPercent: number;
  wallClockSpeedupMultiplier: number;
  meetsRequestReductionThreshold: boolean;
  meetsSpeedupThreshold: boolean;
  completenessPreserved: boolean;
}

export const REPRESENTATIVE_REPOS: Record<string, 'small' | 'medium' | 'high'> = {
  'ascend/pytorch': 'small',
  'triton-lang/triton': 'medium',
  'sgl-project/sglang': 'high',
};

export const REQUEST_REDUCTION_TARGET_PERCENT = 50;
export const WALL_CLOCK_SPEEDUP_TARGET_MULTIPLIER = 2.0;

export function createInstrumentedClient(octokit: Octokit): {
  client: Octokit;
  getAccounting: () => RequestAccounting;
  resetAccounting: () => void;
} {
  let listRequests = 0;
  let jobsRequests = 0;
  let rerunJobsRequests = 0;
  let conditional304s = 0;
  let otherRequests = 0;
  let totalRequestElapsedMs = 0;

  const client = {
    ...octokit,
    request: async (route: string, parameters?: Record<string, unknown>) => {
      const start = Date.now();
      try {
        const res = await octokit.request(route, parameters);
        const elapsed = Date.now() - start;
        totalRequestElapsedMs += elapsed;

        if (route.includes('/jobs') && (parameters?.attempt_number || route.includes('/attempts/'))) {
          rerunJobsRequests += 1;
        } else if (route.includes('/jobs')) {
          jobsRequests += 1;
        } else if (route.includes('/runs')) {
          listRequests += 1;
        } else {
          otherRequests += 1;
        }
        return res;
      } catch (err: unknown) {
        const elapsed = Date.now() - start;
        totalRequestElapsedMs += elapsed;
        const status = (err as Record<string, unknown>)?.status;
        if (status === 304) {
          conditional304s += 1;
          listRequests += 1;
        } else if (route.includes('/runs')) {
          listRequests += 1;
        } else if (route.includes('/jobs')) {
          jobsRequests += 1;
        } else {
          otherRequests += 1;
        }
        throw err;
      }
    },
  } as Octokit;

  return {
    client,
    getAccounting: () => ({
      listRequests,
      jobsRequests,
      rerunJobsRequests,
      conditional304s,
      otherRequests,
      totalRequests: listRequests + jobsRequests + rerunJobsRequests + otherRequests,
      totalRequestElapsedMs,
    }),
    resetAccounting: () => {
      listRequests = 0;
      jobsRequests = 0;
      rerunJobsRequests = 0;
      conditional304s = 0;
      otherRequests = 0;
      totalRequestElapsedMs = 0;
    },
  };
}

export function compareBenchmarkResults(
  repo: string,
  cold: CollectionMetrics,
  warm: CollectionMetrics,
  sizeCategory?: 'small' | 'medium' | 'high' | 'all' | 'other',
): BenchmarkComparison {
  const requestReductionPercent = cold.requests.totalRequests > 0
    ? ((cold.requests.totalRequests - warm.requests.totalRequests) / cold.requests.totalRequests) * 100
    : 0;

  const wallClockSpeedupMultiplier = warm.wallClockMs > 0
    ? cold.wallClockMs / warm.wallClockMs
    : 1;

  const completenessPreserved =
    warm.runs >= cold.runs &&
    warm.attempts >= cold.attempts &&
    warm.jobs >= cold.jobs &&
    warm.steps >= cold.steps;

  return {
    repo,
    sizeCategory,
    cold,
    warm,
    requestReductionPercent,
    wallClockSpeedupMultiplier,
    meetsRequestReductionThreshold: requestReductionPercent >= REQUEST_REDUCTION_TARGET_PERCENT,
    meetsSpeedupThreshold: wallClockSpeedupMultiplier >= WALL_CLOCK_SPEEDUP_TARGET_MULTIPLIER,
    completenessPreserved,
  };
}

export function aggregateBenchmarkComparisons(
  comparisons: BenchmarkComparison[],
  aggregateName = 'All Tracked Repositories',
): BenchmarkComparison {
  const coldRequests: RequestAccounting = {
    listRequests: 0,
    jobsRequests: 0,
    rerunJobsRequests: 0,
    conditional304s: 0,
    otherRequests: 0,
    totalRequests: 0,
    totalRequestElapsedMs: 0,
  };

  const warmRequests: RequestAccounting = {
    listRequests: 0,
    jobsRequests: 0,
    rerunJobsRequests: 0,
    conditional304s: 0,
    otherRequests: 0,
    totalRequests: 0,
    totalRequestElapsedMs: 0,
  };

  let coldWallClockMs = 0;
  let warmWallClockMs = 0;
  let coldRuns = 0;
  let warmRuns = 0;
  let coldAttempts = 0;
  let warmAttempts = 0;
  let coldJobs = 0;
  let warmJobs = 0;
  let coldSteps = 0;
  let warmSteps = 0;

  for (const c of comparisons) {
    coldRequests.listRequests += c.cold.requests.listRequests;
    coldRequests.jobsRequests += c.cold.requests.jobsRequests;
    coldRequests.rerunJobsRequests += c.cold.requests.rerunJobsRequests;
    coldRequests.conditional304s += c.cold.requests.conditional304s;
    coldRequests.otherRequests += c.cold.requests.otherRequests;
    coldRequests.totalRequests += c.cold.requests.totalRequests;
    coldRequests.totalRequestElapsedMs += c.cold.requests.totalRequestElapsedMs;

    warmRequests.listRequests += c.warm.requests.listRequests;
    warmRequests.jobsRequests += c.warm.requests.jobsRequests;
    warmRequests.rerunJobsRequests += c.warm.requests.rerunJobsRequests;
    warmRequests.conditional304s += c.warm.requests.conditional304s;
    warmRequests.otherRequests += c.warm.requests.otherRequests;
    warmRequests.totalRequests += c.warm.requests.totalRequests;
    warmRequests.totalRequestElapsedMs += c.warm.requests.totalRequestElapsedMs;

    coldWallClockMs += c.cold.wallClockMs;
    warmWallClockMs += c.warm.wallClockMs;
    coldRuns += c.cold.runs;
    warmRuns += c.warm.runs;
    coldAttempts += c.cold.attempts;
    warmAttempts += c.warm.attempts;
    coldJobs += c.cold.jobs;
    warmJobs += c.warm.jobs;
    coldSteps += c.cold.steps;
    warmSteps += c.warm.steps;
  }

  const cold: CollectionMetrics = {
    requests: coldRequests,
    wallClockMs: coldWallClockMs,
    runs: coldRuns,
    attempts: coldAttempts,
    jobs: coldJobs,
    steps: coldSteps,
  };

  const warm: CollectionMetrics = {
    requests: warmRequests,
    wallClockMs: warmWallClockMs,
    runs: warmRuns,
    attempts: warmAttempts,
    jobs: warmJobs,
    steps: warmSteps,
  };

  return compareBenchmarkResults(aggregateName, cold, warm, 'all');
}

export function formatBenchmarkReport(comparisons: BenchmarkComparison[]): string {
  const lines: string[] = [
    '# Collection Benchmark: 3-Day Historical Snapshot Comparison',
    '',
    `Acceptance Targets: REST Request Reduction >= ${REQUEST_REDUCTION_TARGET_PERCENT}%, Wall-Clock Speedup >= ${WALL_CLOCK_SPEEDUP_TARGET_MULTIPLIER}x, Completeness = 100%`,
    '',
    '| Repository | Size | Cold Req | Warm Req | Reduction | Cold Wall | Warm Wall | Speedup | Completeness | Status |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const c of comparisons) {
    const passed = c.meetsRequestReductionThreshold && c.meetsSpeedupThreshold && c.completenessPreserved;
    const status = passed ? 'PASS' : 'FAIL';
    const coldSec = (c.cold.wallClockMs / 1000).toFixed(1) + 's';
    const warmSec = (c.warm.wallClockMs / 1000).toFixed(1) + 's';
    const reduction = c.requestReductionPercent.toFixed(1) + '%';
    const speedup = c.wallClockSpeedupMultiplier.toFixed(1) + 'x';
    const completeness = c.completenessPreserved ? 'PASS' : 'REGRESSION';
    lines.push(
      `| ${c.repo} | ${c.sizeCategory ?? 'other'} | ${c.cold.requests.totalRequests} | ${c.warm.requests.totalRequests} | ${reduction} | ${coldSec} | ${warmSec} | ${speedup} | ${completeness} | ${status} |`,
    );
  }

  return lines.join('\n');
}

export interface BenchmarkCliOptions {
  repo?: string;
  representatives: boolean;
  all: boolean;
  days: number;
  json: boolean;
  help: boolean;
}

export function parseBenchmarkCliOptions(argv: string[]): BenchmarkCliOptions {
  let repo: string | undefined;
  let representatives = false;
  let all = false;
  let days = 3;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--repo' || arg === '-r') {
      repo = argv[index + 1];
      index += 1;
    } else if (arg === '--representatives' || arg === '--rep') {
      representatives = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--days' || arg === '-d') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) days = parsed;
      index += 1;
    } else if (arg === '--json') {
      json = true;
    }
  }

  if (!repo && !all && !representatives) {
    representatives = true;
  }

  return { repo, representatives, all, days, json, help };
}

export async function main() {
  const options = parseBenchmarkCliOptions(process.argv.slice(2));

  if (options.help) {
    console.log(`
Usage: npx tsx etl/scripts/benchmark-collection.ts [options]

Benchmark 3-day cold vs warm collection performance across representative or all repositories.

Options:
  -r, --repo <owner/repo>   Benchmark a specific repository
  --representatives, --rep  Benchmark representative sizes (ascend/pytorch, triton, sglang) [default]
  --all                     Benchmark all 13 configured repositories
  -d, --days <N>            Days scope for collection window (default: 3)
  --json                    Output structured JSON results
  -h, --help                Show this help message
`.trim());
    return;
  }

  const tokens = resolveGitHubTokens();
  if (tokens.length === 0) {
    console.error('No GitHub tokens found. Configure GITHUB_TOKEN, gh-token.txt, or run gh auth login.');
    process.exit(1);
  }

  const configPath = path.join(__dirname, '../repos.yaml');
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const reposConfig = parseReposConfig(configContent);

  const targetRepos: string[] = options.repo
    ? [options.repo]
    : options.all
      ? getRepoNames(reposConfig)
      : Object.keys(REPRESENTATIVE_REPOS);

  const octokit = createOctokit(tokens[0]);
  const instrumented = createInstrumentedClient(octokit);
  const comparisons: BenchmarkComparison[] = [];

  console.log(`Starting collection benchmarks for ${targetRepos.length} repositories (${options.days} days)...`);

  for (const repo of targetRepos) {
    const sizeCategory = REPRESENTATIVE_REPOS[repo] ?? 'other';
    console.log(`Benchmarking ${repo} (${sizeCategory})...`);

    const coldCollectOptions: CollectCliOptions = {
      forceFullBackfill: true,
      reverse: true,
      forward: false,
      skipJobs: false,
      collectDays: options.days,
      repoName: repo,
      help: false,
    };

    const warmCollectOptions: CollectCliOptions = {
      forceFullBackfill: false,
      reverse: true,
      forward: false,
      skipJobs: false,
      collectDays: options.days,
      repoName: repo,
      help: false,
    };

    const plannedWindows = buildCollectionWindows({
      latest: '',
      existingFileCount: 0,
      historyComplete: false,
      backfillCursor: undefined,
      retentionDays: options.days,
      forceFullBackfill: false,
      reverse: true,
    });

    // Cold pass
    instrumented.resetAccounting();
    const coldStart = Date.now();
    const coldStats = await collectRepo(instrumented.client, repo, options.days, coldCollectOptions, reposConfig, plannedWindows);
    const coldWallClockMs = Date.now() - coldStart;
    const coldRequests = instrumented.getAccounting();
    const coldDbCounts = await queryRepoEntityCounts(repo);

    const coldMetrics: CollectionMetrics = {
      requests: coldRequests,
      wallClockMs: coldWallClockMs,
      runs: coldDbCounts.runs > 0 ? coldDbCounts.runs : (coldStats?.collectedRuns ?? 0),
      attempts: coldDbCounts.attempts > 0 ? coldDbCounts.attempts : (coldStats?.collectedRuns ?? 0),
      jobs: coldDbCounts.jobs,
      steps: coldDbCounts.steps,
    };

    // Warm pass
    instrumented.resetAccounting();
    const warmStart = Date.now();
    const warmStats = await collectRepo(instrumented.client, repo, options.days, warmCollectOptions, reposConfig, plannedWindows);
    const warmWallClockMs = Date.now() - warmStart;
    const warmRequests = instrumented.getAccounting();
    const warmDbCounts = await queryRepoEntityCounts(repo);

    const warmMetrics: CollectionMetrics = {
      requests: warmRequests,
      wallClockMs: warmWallClockMs,
      runs: warmDbCounts.runs > 0 ? warmDbCounts.runs : (warmStats?.collectedRuns ?? coldMetrics.runs),
      attempts: warmDbCounts.attempts > 0 ? warmDbCounts.attempts : (warmStats?.collectedRuns ?? coldMetrics.attempts),
      jobs: warmDbCounts.jobs > 0 ? warmDbCounts.jobs : coldMetrics.jobs,
      steps: warmDbCounts.steps > 0 ? warmDbCounts.steps : coldMetrics.steps,
    };

    const comparison = compareBenchmarkResults(repo, coldMetrics, warmMetrics, sizeCategory);
    comparisons.push(comparison);
  }

  if (comparisons.length > 1) {
    comparisons.push(aggregateBenchmarkComparisons(comparisons));
  }

  if (options.json) {
    console.log(JSON.stringify(comparisons, null, 2));
  } else {
    console.log('\n' + formatBenchmarkReport(comparisons));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
