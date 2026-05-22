import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { rebuildPullRequestArtifacts } from './pr-artifacts';
import { getExistingRunIdsFromSupabase } from './supabase-storage';
import { createClient } from '@supabase/supabase-js';
import type { Run } from '../../src/lib/types';

interface IndexFile {
  files?: unknown;
}

interface ReposConfig {
  repos?: unknown;
}

function getRepoDir(repo: string): string {
  const [owner, name] = repo.split('/');
  return path.join(__dirname, '../../data', owner, name);
}

function readReposConfig(): string[] {
  const reposConfigPath = path.join(__dirname, '../repos.yaml');
  if (!fs.existsSync(reposConfigPath)) {
    return [];
  }

  const content = fs.readFileSync(reposConfigPath, 'utf8');
  const config = yaml.load(content) as ReposConfig | null;

  return Array.isArray(config?.repos) ? config.repos.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readIndex(repo: string): string[] {
  const indexPath = path.join(getRepoDir(repo), 'index.json');
  try {
    if (!fs.existsSync(indexPath)) {
      return [];
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexFile;
    return Array.isArray(index.files) ? index.files.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch (error) {
    console.warn(`Warning: Failed to read index for ${repo}:`, error instanceof Error ? error.message : error);
    return [];
  }
}

function parseTargetRepos(argv: string[]): string[] {
  const explicitRepos: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--repo' || arg === '-r') && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      explicitRepos.push(argv[index + 1]);
      index += 1;
    }
  }

  return explicitRepos.length > 0 ? explicitRepos : readReposConfig();
}

async function fetchRunsFromSupabase(repo: string, dates: string[]): Promise<Run[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const [owner, repoName] = repo.split('/');

  const { data: repoData } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repoName)
    .single();

  if (!repoData) {
    console.warn(`Repo ${repo} not found in Supabase`);
    return [];
  }

  const allRuns: Run[] = [];
  for (const date of dates) {
    const { data: runs, error } = await supabase
      .from('runs')
      .select('*, jobs(*)')
      .eq('repo_id', repoData.id)
      .eq('date', date);

    if (error) {
      console.warn(`Error fetching runs for ${repo} on ${date}: ${error.message}`);
      continue;
    }

    for (const row of runs || []) {
      const run: Run = {
        id: Number(row.id),
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
        pull_requests: [],
        jobs: (row.jobs || []).map((j: Record<string, unknown>) => ({
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
    }
  }

  return allRuns;
}

async function main() {
  const targetRepos = parseTargetRepos(process.argv.slice(2));
  if (targetRepos.length === 0) {
    console.warn('No repositories found to process. Use --repo <owner/repo> or check etl/repos.yaml.');
    return;
  }

  for (const repoKey of targetRepos) {
    const [owner, repo] = repoKey.split('/');
    if (!owner || !repo) {
      console.warn(`Skipping invalid repo key: ${repoKey}`);
      continue;
    }

    const repoDir = getRepoDir(repoKey);
    const files = readIndex(repoKey);
    if (files.length === 0) {
      console.warn(`Skipping ${repoKey}: no retained files in index.json`);
      continue;
    }

    try {
      const dates = files.map((f) => f.replace(/\.json$/, ''));
      const runs = await fetchRunsFromSupabase(repoKey, dates);

      await rebuildPullRequestArtifacts({
        owner,
        repo,
        repoKey,
        repoDir,
        files,
        runs,
        log: (...args: unknown[]) => console.log(...args),
        warn: (...args: unknown[]) => console.warn(...args),
      });

      console.log(`Rebuilt PR artifacts for ${repoKey}`);
    } catch (error) {
      console.error(`Error rebuilding PR artifacts for ${repoKey}:`, error instanceof Error ? error.message : error);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
