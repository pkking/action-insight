/**
 * Purge retention-enforced rows from Turso tables.
 * Deletes runs/jobs/steps/pr_metrics older than the configured retention
 * window so that the database stays within free-tier limits.
 *
 * Usage:
 *   TURSO_DATABASE_URL=xxx TURSO_AUTH_TOKEN=xxx npx tsx etl/scripts/purge-turso.ts
 *   TURSO_DATABASE_URL=xxx TURSO_AUTH_TOKEN=xxx RETENTION_DAYS=30 npx tsx etl/scripts/purge-turso.ts --repo vllm-project/vllm-ascend
 *
 * Environment:
 *   TURSO_DATABASE_URL            Turso database URL (required, e.g., file:./data.db or libsqls://...)
 *   TURSO_AUTH_TOKEN              Turso auth token (required for remote)
 *   RETENTION_DAYS                Retention window in days (default: 30)
 */

import { createClient, type Client, type InValue } from '@libsql/client';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const DEFAULT_RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);

const repoFlagIdx = process.argv.indexOf('--repo');
let TARGET_REPO: string | null = null;
if (repoFlagIdx >= 0) {
  const val = process.argv[repoFlagIdx + 1];
  if (!val || val.startsWith('-')) {
    console.error('Error: --repo flag requires a repository argument (e.g., owner/repo)');
    process.exit(1);
  }
  TARGET_REPO = val;
}

if (!TURSO_DATABASE_URL) {
  console.error('Error: TURSO_DATABASE_URL is required');
  process.exit(1);
}

const client = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

// Enable foreign keys so ON DELETE CASCADE works correctly
await client.execute('PRAGMA foreign_keys = ON');

async function getReposToPurge(): Promise<{ id: number; owner: string; repo: string }[]> {
  if (TARGET_REPO) {
    const [owner, repoName] = TARGET_REPO.split('/');
    if (!owner || !repoName) {
      console.error(`Error: Invalid repo format "${TARGET_REPO}". Expected "owner/repo".`);
      process.exit(1);
    }
    const { rows } = await client.execute({
      sql: `SELECT id, owner, repo FROM repos WHERE owner = ? AND repo = ?`,
      args: [owner, repoName],
    });
    if (rows.length === 0) {
      console.error(`Error: Repository "${TARGET_REPO}" not found in database.`);
      process.exit(1);
    }
    return rows.map((r) => ({
      id: Number(r.id),
      owner: r.owner as string,
      repo: r.repo as string,
    }));
  } else {
    const { rows } = await client.execute(`SELECT id, owner, repo FROM repos`);
    return rows.map((r) => ({
      id: Number(r.id),
      owner: r.owner as string,
      repo: r.repo as string,
    }));
  }
}

async function purgeOldRuns(repoId: number, repoKey: string, retentionDays: number): Promise<{ runs: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Delete pr_workflows first (no ON DELETE CASCADE on run_id FK)
  await client.execute({
    sql: `DELETE FROM pr_workflows WHERE run_id IN (SELECT id FROM runs WHERE repo_id = ? AND date < ?)`,
    args: [repoId, cutoffStr],
  });

  // Delete runs (ON DELETE CASCADE handles jobs → steps)
  const result = await client.execute({
    sql: `DELETE FROM runs WHERE repo_id = ? AND date < ?`,
    args: [repoId, cutoffStr],
  });

  const count = Number(result.rowsAffected ?? 0);
  if (count > 0) {
    console.log(`  [purge] ${repoKey}: deleted ${count} runs (jobs/steps cascade, pr_workflows manual), cutoff=${cutoffStr}`);
  }
  return { runs: count };
}

async function purgeOldPrMetrics(repoId: number, repoKey: string, retentionDays: number): Promise<{ prMetrics: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const result = await client.execute({
    sql: `DELETE FROM pr_metrics WHERE repo_id = ? AND created_at < ?`,
    args: [repoId, cutoffStr],
  });

  const count = Number(result.rowsAffected ?? 0);
  if (count > 0) {
    console.log(`  [purge] ${repoKey}: deleted ${count} pr_metrics (pr_workflows cascade), cutoff=${cutoffStr}`);
  }
  return { prMetrics: count };
}

async function purgePrResolutionCache(repoId: number, repoKey: string, retentionDays: number): Promise<{ cacheEntries: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString();

  const result = await client.execute({
    sql: `DELETE FROM pr_resolution_cache WHERE repo_id = ? AND attempted_at < ?`,
    args: [repoId, cutoffStr],
  });

  const count = Number(result.rowsAffected ?? 0);
  if (count > 0) {
    console.log(`  [purge] ${repoKey}: deleted ${count} pr_resolution_cache entries, cutoff=${cutoffStr}`);
  }
  return { cacheEntries: count };
}

async function printTableSizes() {
  console.log('\n=== Current table sizes ===');
  for (const table of ['runs', 'jobs', 'steps', 'pr_metrics', 'pr_workflows', 'pr_resolution_cache']) {
    const { rows } = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ${table}`,
      args: [],
    });
    const count = rows[0]?.cnt as number;
    console.log(`  ${table}: ${count} rows`);
  }
}

async function main() {
  console.log('=== Turso Data Purge ===');
  console.log(`Retention: ${DEFAULT_RETENTION_DAYS} days\n`);

  const repos = await getReposToPurge();

  let totalRuns = 0;
  let totalMetrics = 0;
  let totalCache = 0;

  for (const repo of repos) {
    const repoKey = `${repo.owner}/${repo.repo}`;
    console.log(`--- ${repoKey} ---`);
    const r = await purgeOldRuns(repo.id, repoKey, DEFAULT_RETENTION_DAYS);
    const m = await purgeOldPrMetrics(repo.id, repoKey, DEFAULT_RETENTION_DAYS);
    const c = await purgePrResolutionCache(repo.id, repoKey, DEFAULT_RETENTION_DAYS);
    totalRuns += r.runs;
    totalMetrics += m.prMetrics;
    totalCache += c.cacheEntries;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Runs deleted:              ${totalRuns}`);
  console.log(`PR metrics deleted:        ${totalMetrics}`);
  console.log(`PR resolution cache purged: ${totalCache}`);
  console.log('(jobs/steps/pr_workflows deleted via CASCADE)');

  await printTableSizes();
  client.close();
}

main().catch(console.error);
