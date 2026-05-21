/**
 * Migration script: Import existing JSON data from data/ directory into Supabase.
 *
 * Usage:
 *   npx tsx etl/scripts/migrate-to-supabase.ts
 *
 * Reads all data/{owner}/{repo}/*.json and prs/*.json files,
 * inserts repos, runs, jobs, pr_metrics, and pr_workflows into Supabase.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing required database configuration. Please check your environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const DATA_DIR = join(process.cwd(), 'data');

interface Run {
  id: number;
  name: string;
  head_branch: string;
  head_sha?: string;
  status: string;
  conclusion: string;
  event?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  pull_requests?: { number: number }[];
  jobs?: Job[];
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
}

interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

interface PrMetricsSummary {
  number: number;
  title: string;
  branch: string;
  author?: string;
  state: string;
  html_url: string;
  created_at: string;
  ci_started_at?: string;
  ci_completed_at?: string;
  merged_at?: string | null;
  partialCiHistory: boolean;
  timeToCiStartInSeconds?: number;
  ciDurationInSeconds?: number;
  timeToMergeInSeconds?: number;
  mergeLeadTimeInSeconds?: number;
  workflowCount: number;
  successfulWorkflowCount: number;
  conclusion: string;
}

interface PrMetricsDetail {
  repo: string;
  generated_at: string;
  pr: PrMetricsSummary & {
    workflows: Run[];
  };
}

interface PrIndexFile {
  repo: string;
  generated_at: string;
  prs: PrMetricsSummary[];
}

async function ensureRepo(owner: string, repo: string): Promise<number> {
  const { data, error } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  if (data) return data.id;

  const { data: inserted, error: insertError } = await supabase
    .from('repos')
    .insert({ owner, repo })
    .select('id')
    .single();

  if (insertError) {
    // Might be a race condition - try select again
    const { data: retryData } = await supabase
      .from('repos')
      .select('id')
      .eq('owner', owner)
      .eq('repo', repo)
      .single();
    if (retryData) return retryData.id;
    throw new Error(`Failed to insert repo ${owner}/${repo}: ${insertError.message}`);
  }

  return inserted.id;
}

async function insertRuns(repoId: number, runs: Run[], date: string): Promise<void> {
  if (runs.length === 0) return;

  // Batch insert runs
  const runRows = runs.map((run) => ({
    id: run.id,
    repo_id: repoId,
    name: run.name,
    head_branch: run.head_branch,
    head_sha: run.head_sha || null,
    status: run.status,
    conclusion: run.conclusion || null,
    event: run.event || null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    duration_seconds: run.durationInSeconds,
    date,
  }));

  const { error: runError } = await supabase
    .from('runs')
    .upsert(runRows, { onConflict: 'id' })
    .select('id');

  if (runError) {
    console.error(`  Error inserting runs for ${date}: ${runError.message}`);
    return;
  }

  // Batch insert jobs
  const jobRows: {
    id: number;
    run_id: number;
    name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    started_at: string;
    completed_at: string;
    html_url: string;
    queue_duration_seconds: number;
    duration_seconds: number;
  }[] = [];

  for (const run of runs) {
    if (run.jobs && run.jobs.length > 0) {
      for (const job of run.jobs) {
        jobRows.push({
          id: job.id,
          run_id: run.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion || null,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          html_url: job.html_url,
          queue_duration_seconds: job.queueDurationInSeconds,
          duration_seconds: job.durationInSeconds,
        });
      }
    }
  }

  if (jobRows.length > 0) {
    const { error: jobError } = await supabase
      .from('jobs')
      .upsert(jobRows, { onConflict: 'id' });

    if (jobError) {
      console.error(`  Error inserting jobs for ${date}: ${jobError.message}`);
    }
  }
}

async function insertPrMetrics(repoId: number, prs: PrMetricsSummary[]): Promise<void> {
  if (prs.length === 0) return;

  const prRows = prs.map((pr) => ({
    repo_id: repoId,
    pr_number: pr.number,
    title: pr.title,
    branch: pr.branch,
    author: pr.author || null,
    state: pr.state,
    html_url: pr.html_url,
    created_at: pr.created_at,
    ci_started_at: pr.ci_started_at || null,
    ci_completed_at: pr.ci_completed_at || null,
    merged_at: pr.merged_at || null,
    partial_ci_history: pr.partialCiHistory,
    time_to_ci_start_seconds: pr.timeToCiStartInSeconds || null,
    ci_duration_seconds: pr.ciDurationInSeconds || null,
    time_to_merge_seconds: pr.timeToMergeInSeconds || null,
    merge_lead_time_seconds: pr.mergeLeadTimeInSeconds || null,
    workflow_count: pr.workflowCount,
    successful_workflow_count: pr.successfulWorkflowCount,
    conclusion: pr.conclusion || null,
  }));

  const { error } = await supabase
    .from('pr_metrics')
    .upsert(prRows, { onConflict: 'repo_id,pr_number' });

  if (error) {
    console.error(`  Error inserting PR metrics: ${error.message}`);
  }
}

async function migrateRepo(owner: string, repo: string): Promise<void> {
  const repoDir = join(DATA_DIR, owner, repo);

  if (!existsSync(repoDir)) {
    console.log(`  Skipping ${owner}/${repo} - directory not found`);
    return;
  }

  console.log(`\nMigrating ${owner}/${repo}...`);

  const repoId = await ensureRepo(owner, repo);
  console.log(`  Repo ID: ${repoId}`);

  // Read index to get list of files
  const indexPath = join(repoDir, 'index.json');
  if (!existsSync(indexPath)) {
    console.log('  No index.json found, skipping');
    return;
  }

  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  const files: string[] = index.files || [];
  console.log(`  Found ${files.length} daily files`);

  let totalRuns = 0;
  let totalJobs = 0;

  // Process daily files
  for (const fileName of files) {
    const filePath = join(repoDir, fileName);
    if (!existsSync(filePath)) continue;

    try {
      const dayData: DayData = JSON.parse(readFileSync(filePath, 'utf-8'));
      const date = fileName.replace('.json', '');

      await insertRuns(repoId, dayData.runs, date);

      totalRuns += dayData.runs.length;
      dayData.runs.forEach((r) => {
        if (r.jobs) totalJobs += r.jobs.length;
      });
    } catch (err) {
      console.error(`  Error processing ${fileName}:`, err);
    }
  }

  console.log(`  Inserted ${totalRuns} runs, ${totalJobs} jobs`);

  // Process PR data
  const prsDir = join(repoDir, 'prs');
  if (existsSync(prsDir)) {
    const prIndexPath = join(prsDir, 'index.json');
    if (existsSync(prIndexPath)) {
      try {
        const prIndex: PrIndexFile = JSON.parse(readFileSync(prIndexPath, 'utf-8'));
        await insertPrMetrics(repoId, prIndex.prs);
        console.log(`  Inserted ${prIndex.prs.length} PR metrics summaries`);
      } catch (err) {
        console.error('  Error processing PR index:', err);
      }
    }
  }
}

async function main() {
  console.log('Starting migration to Supabase...');
  console.log(`Data directory: ${DATA_DIR}`);

  const owners = readdirSync(DATA_DIR);
  console.log(`Found ${owners.length} owner directories: ${owners.join(', ')}`);

  let totalRepos = 0;

  for (const owner of owners) {
    const ownerDir = join(DATA_DIR, owner);
    if (!existsSync(ownerDir)) continue;

    const repos = readdirSync(ownerDir);
    for (const repo of repos) {
      await migrateRepo(owner, repo);
      totalRepos++;
    }
  }

  console.log(`\nMigration complete! Processed ${totalRepos} repos.`);

  // Verify counts
  const { count: runCount } = await supabase
    .from('runs')
    .select('*', { count: 'exact', headCount: true });

  const { count: jobCount } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', headCount: true });

  const { count: prCount } = await supabase
    .from('pr_metrics')
    .select('*', { count: 'exact', headCount: true });

  console.log(`\nVerification:`);
  console.log(`  Runs: ${runCount}`);
  console.log(`  Jobs: ${jobCount}`);
  console.log(`  PR Metrics: ${prCount}`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
