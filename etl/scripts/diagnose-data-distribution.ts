#!/usr/bin/env npx tsx
/**
 * Diagnostic script: check data distribution for e2e-light workflows
 * across different date ranges to identify if the issue is:
 * 1. Database data distribution (all runs are within 7 days)
 * 2. API query not reaching the database correctly
 * 3. Frontend date range calculation bug
 *
 * Usage: SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx etl/scripts/diagnose-data-distribution.ts
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required');
  console.error('Usage: SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx etl/scripts/diagnose-data-distribution.ts');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('=== E2E-Light Workflow Data Distribution Analysis ===\n');

  // 1. Get the repo_id for vllm-project/vllm-ascend
  const { data: repoData, error: repoError } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', 'vllm-project')
    .eq('repo', 'vllm-ascend')
    .single();

  if (repoError || !repoData) {
    console.error('Failed to find repo_id for vllm-project/vllm-ascend');
    process.exit(1);
  }

  const repoId = repoData.id;
  console.log(`Repo ID: ${repoId}\n`);

  // 2. Check the latest run date in the database
  const { data: latestRuns, error: latestError } = await supabase
    .from('runs')
    .select('date, name')
    .eq('repo_id', repoId)
    .order('date', { ascending: false })
    .limit(5);

  if (latestError) {
    console.error('Failed to fetch latest runs:', latestError);
    process.exit(1);
  }

  console.log('5 latest runs:');
  latestRuns.forEach((run: any) => {
    console.log(`  - date: ${run.date}, name: ${run.name}`);
  });

  const latestDate = latestRuns[0]?.date;
  if (!latestDate) {
    console.log('No runs found in database');
    process.exit(0);
  }

  console.log(`\nLatest date: ${latestDate}\n`);

  // 3. Count e2e-light runs by date (last 30 days from latest date)
  const { data: e2eLightRuns, error: e2eError } = await supabase
    .from('runs')
    .select('date, id, name')
    .eq('repo_id', repoId)
    .eq('name', 'e2e-light')
    .gte('date', new Date(new Date(latestDate).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
    .order('date', { ascending: true });

  if (e2eError) {
    console.error('Failed to fetch e2e-light runs:', e2eError);
    process.exit(1);
  }

  // Count by date
  const dateCounts = new Map<string, number>();
  for (const run of e2eLightRuns || []) {
    const date = run.date;
    dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
  }

  console.log('E2E-light runs by date (last 30 days):');
  const sortedDates = [...dateCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [date, count] of sortedDates) {
    console.log(`  ${date}: ${count} runs`);
  }

  // 4. Calculate cumulative counts
  console.log('\n=== Cumulative counts (from latest date backwards) ===');
  let cumulative7 = 0;
  let cumulative14 = 0;
  let cumulative30 = 0;
  
  for (const [date, count] of sortedDates.reverse()) {
    const daysAgo = Math.floor((new Date(latestDate).getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
    if (daysAgo <= 7) cumulative7 += count;
    if (daysAgo <= 14) cumulative14 += count;
    if (daysAgo <= 30) cumulative30 += count;
  }

  console.log(`7 days:  ${cumulative7} runs`);
  console.log(`14 days: ${cumulative14} runs`);
  console.log(`30 days: ${cumulative30} runs`);

  if (cumulative7 === cumulative14 && cumulative14 === cumulative30) {
    console.log('\n⚠️  DIAGNOSIS: All e2e-light runs are within 7 days of the latest date!');
    console.log('This means changing the date range selector has no effect because');
    console.log('there are no runs outside the 7-day window in the database.');
  } else if (cumulative7 < cumulative30) {
    console.log('\n✓ Database has different counts for different date ranges.');
    console.log('If the UI shows the same count, the issue is in the frontend/API layer.');
  }

  // 5. Check total runs
  const { count: totalCount, error: countError } = await supabase
    .from('runs')
    .select('*', { count: 'exact', head: true })
    .eq('repo_id', repoId)
    .eq('name', 'e2e-light');

  if (!countError) {
    console.log(`\nTotal e2e-light runs: ${totalCount}`);
  }
}

main().catch(console.error);
