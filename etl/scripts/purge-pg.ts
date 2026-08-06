/**
 * Purge retention-enforced rows from PostgreSQL tables.
 * Deletes runs/jobs/steps/pr_metrics older than the configured retention
 * window so the database stays within storage limits.
 *
 * Usage:
 *   PG_DATABASE_URL=xxx npx tsx etl/scripts/purge-pg.ts
 *   PG_DATABASE_URL=xxx RETENTION_DAYS=30 npx tsx etl/scripts/purge-pg.ts --repo vllm-project/vllm-ascend
 */

import { getDatabaseClient } from '../../src/lib/db.ts';
import { toPgSql } from './pg-utils.ts';

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

async function getReposToPurge(): Promise<{ id: number; owner: string; repo: string }[]> {
  const client = await getDatabaseClient();
  try {
    if (TARGET_REPO) {
      const [owner, repoName] = TARGET_REPO.split('/');
      if (!owner || !repoName) {
        console.error(`Error: Invalid repo format "${TARGET_REPO}". Expected "owner/repo".`);
        process.exit(1);
      }
      const { rows } = await client.query(
        `SELECT id, owner, repo FROM repos WHERE owner = $1 AND repo = $2`,
        [owner, repoName],
      );
      if (rows.length === 0) {
        console.error(`Error: Repository "${TARGET_REPO}" not found in database.`);
        process.exit(1);
      }
      return rows.map((r) => ({ id: Number(r.id), owner: r.owner as string, repo: r.repo as string }));
    }
    const { rows } = await client.query(`SELECT id, owner, repo FROM repos`);
    return rows.map((r) => ({ id: Number(r.id), owner: r.owner as string, repo: r.repo as string }));
  } finally {
    client.release();
  }
}

async function purgeOldRuns(repoId: number, repoKey: string, retentionDays: number): Promise<{ runs: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const client = await getDatabaseClient();

  try {
    await client.query(
      `DELETE FROM pr_workflows WHERE run_id IN (SELECT id FROM runs WHERE repo_id = $1 AND date < $2)`,
      [repoId, cutoffStr],
    );

    const result = await client.query(
      `DELETE FROM runs WHERE repo_id = $1 AND date < $2`,
      [repoId, cutoffStr],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`  [purge] ${repoKey}: deleted ${count} runs (jobs/steps cascade, pr_workflows manual), cutoff=${cutoffStr}`);
    }
    return { runs: count };
  } finally {
    client.release();
  }
}

async function purgeOldPrMetrics(repoId: number, repoKey: string, retentionDays: number): Promise<{ prMetrics: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const client = await getDatabaseClient();

  try {
    const result = await client.query(
      `DELETE FROM pr_metrics WHERE repo_id = $1 AND created_at < $2`,
      [repoId, cutoffStr],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`  [purge] ${repoKey}: deleted ${count} pr_metrics (pr_workflows cascade), cutoff=${cutoffStr}`);
    }
    return { prMetrics: count };
  } finally {
    client.release();
  }
}

async function purgePrResolutionCache(repoId: number, repoKey: string, retentionDays: number): Promise<{ cacheEntries: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString();
  const client = await getDatabaseClient();

  try {
    const result = await client.query(
      `DELETE FROM pr_resolution_cache WHERE repo_id = $1 AND attempted_at < $2`,
      [repoId, cutoffStr],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`  [purge] ${repoKey}: deleted ${count} pr_resolution_cache entries, cutoff=${cutoffStr}`);
    }
    return { cacheEntries: count };
  } finally {
    client.release();
  }
}

async function printTableSizes() {
  console.log('\n=== Current table sizes ===');
  const client = await getDatabaseClient();
  try {
    for (const table of ['runs', 'jobs', 'steps', 'pr_metrics', 'pr_workflows', 'pr_resolution_cache']) {
      const { rows } = await client.query(`SELECT COUNT(*) as cnt FROM ${table}`);
      const count = Number(rows[0]?.cnt ?? 0);
      console.log(`  ${table}: ${count} rows`);
    }
  } finally {
    client.release();
  }
}

async function main() {
  console.log('=== PostgreSQL Data Purge ===');
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
}

main().catch(console.error);
