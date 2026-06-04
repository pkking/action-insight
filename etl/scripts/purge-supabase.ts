/**
 * Purge retention-enforced rows from Supabase tables.
 * Deletes runs/jobs/steps/pr_metrics older than the configured retention
 * window so that the database stays within free-tier limits.
 *
 * Usage:
 *   SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx etl/scripts/purge-supabase.ts
 *   SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx RETENTION_DAYS=30 npx tsx etl/scripts/purge-supabase.ts --repo vllm-project/vllm-ascend
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);

const repoFlagIdx = process.argv.indexOf('--repo');
const TARGET_REPO = repoFlagIdx >= 0 ? process.argv[repoFlagIdx + 1] : null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getRepoId(owner: string, repo: string): Promise<number | null> {
  const { data } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();
  return data?.id ?? null;
}

export async function purgeOldRuns(repoKey: string, retentionDays: number): Promise<{ runs: number }> {
  const [owner, repoName] = repoKey.split('/');
  if (!owner || !repoName) return { runs: 0 };

  const repoId = await getRepoId(owner, repoName);
  if (!repoId) return { runs: 0 };

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { data: deletedRuns, error } = await supabase
    .from('runs')
    .delete()
    .eq('repo_id', repoId)
    .lt('date', cutoffStr)
    .select('id');

  if (error) {
    console.error(`  [purge] Error deleting old runs for ${repoKey}: ${error.message}`);
    return { runs: 0 };
  }

  const count = deletedRuns?.length ?? 0;
  if (count > 0) {
    console.log(`  [purge] ${repoKey}: deleted ${count} runs (jobs/steps cascade), cutoff=${cutoffStr}`);
  }
  return { runs: count };
}

export async function purgeOldPrMetrics(repoKey: string, retentionDays: number): Promise<{ prMetrics: number }> {
  const [owner, repoName] = repoKey.split('/');
  if (!owner || !repoName) return { prMetrics: 0 };

  const repoId = await getRepoId(owner, repoName);
  if (!repoId) return { prMetrics: 0 };

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { data: deleted, error } = await supabase
    .from('pr_metrics')
    .delete()
    .eq('repo_id', repoId)
    .lt('created_at', cutoffStr)
    .select('id');

  if (error) {
    console.error(`  [purge] Error deleting old pr_metrics for ${repoKey}: ${error.message}`);
    return { prMetrics: 0 };
  }

  const count = deleted?.length ?? 0;
  if (count > 0) {
    console.log(`  [purge] ${repoKey}: deleted ${count} pr_metrics (pr_workflows cascade), cutoff=${cutoffStr}`);
  }
  return { prMetrics: count };
}

async function printTableSizes() {
  console.log('\n=== Current table sizes ===');
  for (const table of ['runs', 'jobs', 'steps', 'pr_metrics', 'pr_workflows', 'pr_resolution_cache']) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (!error) {
      console.log(`  ${table}: ${count ?? '?'} rows`);
    }
  }
}

async function main() {
  console.log('=== Supabase Data Purge ===');
  console.log(`Retention: ${DEFAULT_RETENTION_DAYS} days\n`);

  let reposToPurge: string[] = [];

  if (TARGET_REPO) {
    reposToPurge = [TARGET_REPO];
  } else {
    const { data: repos } = await supabase.from('repos').select('owner,repo');
    reposToPurge = (repos || []).map((r) => `${r.owner}/${r.repo}`);
  }

  let totalRuns = 0;
  let totalMetrics = 0;

  for (const repoKey of reposToPurge) {
    console.log(`--- ${repoKey} ---`);
    const r = await purgeOldRuns(repoKey, DEFAULT_RETENTION_DAYS);
    const m = await purgeOldPrMetrics(repoKey, DEFAULT_RETENTION_DAYS);
    totalRuns += r.runs;
    totalMetrics += m.prMetrics;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Runs deleted:        ${totalRuns}`);
  console.log(`PR metrics deleted:  ${totalMetrics}`);
  console.log('(jobs/steps/pr_workflows deleted via CASCADE)');

  await printTableSizes();
}

main().catch(console.error);
