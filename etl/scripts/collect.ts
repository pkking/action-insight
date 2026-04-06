// ETL script: fetches GitHub Actions runs/jobs and writes daily JSON files
import { Octokit } from 'octokit';
import { format, subDays, parseISO, isBefore } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface Run {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
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

interface Index {
  version: number;
  repos: Record<string, { latest: string; files: string[]; retention_days: number }>;
  last_updated: string;
}

interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

interface ReposConfig {
  repos: string[];
}

const ETL_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, '../../data');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const REPOS_CONFIG_PATH = path.join(ETL_DIR, 'repos.yaml');

function readIndex(): Index {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return { version: 1, repos: {}, last_updated: '' };
  }
}

function writeIndex(index: Index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function readReposConfig(): string[] {
  try {
    const content = fs.readFileSync(REPOS_CONFIG_PATH, 'utf-8');
    const config = yaml.load(content) as ReposConfig;
    return config.repos || [];
  } catch (err) {
    console.warn('Failed to read repos.yaml, falling back to environment variable');
    return (process.env.TARGET_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  }
}

function readDayData(date: string): DayData {
  const filePath = path.join(DATA_DIR, `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { date, repo: '', runs: [] };
  }
}

function writeDayData(data: DayData) {
  const filePath = path.join(DATA_DIR, `${data.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const targetRepos = readReposConfig();
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90');

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (targetRepos.length === 0) {
    console.log('No repositories configured. Skipping collection.');
    return;
  }

  const octokit = new Octokit({ auth: token });
  const index = readIndex();

  for (const repo of targetRepos) {
    console.log(`Processing ${repo}...`);
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      console.error(`Invalid repo format: ${repo}. Expected owner/repo`);
      continue;
    }

    const repoIndex = index.repos[repo];
    const lastUpdated = repoIndex?.latest 
      ? parseISO(repoIndex.latest)
      : subDays(new Date(), retentionDays);

    const createdParam = `created:>=${format(lastUpdated, 'yyyy-MM-dd')}`;
    
    const allRuns: Run[] = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
        owner,
        repo: repoName,
        per_page: 100,
        page,
        created: createdParam,
      });

      if (data.workflow_runs.length === 0) break;

      for (const run of data.workflow_runs) {
        if (run.status !== 'completed') continue;

        const { data: jobsData } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
          owner,
          repo: repoName,
          run_id: run.id,
        });

        const jobs: Job[] = jobsData.jobs.map((j: any) => {
          const createdMs = j.created_at ? new Date(j.created_at).getTime() : 0;
          const startedMs = j.started_at ? new Date(j.started_at).getTime() : createdMs;
          const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : startedMs;
          return {
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion ?? 'unknown',
            created_at: j.created_at ?? new Date().toISOString(),
            started_at: j.started_at,
            completed_at: j.completed_at ?? new Date().toISOString(),
            html_url: j.html_url,
            queueDurationInSeconds: Math.max(0, (startedMs - createdMs) / 1000),
            durationInSeconds: Math.max(0, (completedMs - startedMs) / 1000),
          };
        });

        allRuns.push({
          id: run.id,
          name: run.name ?? 'unknown',
          head_branch: run.head_branch ?? 'unknown',
          status: run.status ?? 'completed',
          conclusion: run.conclusion ?? 'unknown',
          created_at: run.created_at,
          updated_at: run.updated_at,
          html_url: run.html_url,
          durationInSeconds: (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
          jobs,
        });
      }

      if (data.workflow_runs.length < 100) break;
      page++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const runsByDate: Record<string, Run[]> = {};
    for (const run of allRuns) {
      const date = format(new Date(run.created_at), 'yyyy-MM-dd');
      if (!runsByDate[date]) runsByDate[date] = [];
      runsByDate[date].push(run);
    }

    const dates = Object.keys(runsByDate).sort().reverse();
    const files = index.repos[repo]?.files || [];

    for (const date of dates) {
      console.log(`  Writing ${date}.json (${runsByDate[date].length} runs)`);
      const existing = readDayData(date);
      const runMap = new Map(existing.runs.map(r => [r.id, r]));
      for (const run of runsByDate[date]) runMap.set(run.id, run);
      
      writeDayData({ date, repo, runs: Array.from(runMap.values()) });
      
      if (!files.includes(`${date}.json`)) {
        files.push(`${date}.json`);
      }
    }

    files.sort().reverse();

    index.repos[repo] = {
      latest: dates[0] || repoIndex?.latest || '',
      files,
      retention_days: retentionDays,
    };
    index.last_updated = new Date().toISOString();

    const cutoffDate = subDays(new Date(), retentionDays);
    const filesToRemove = files.filter(f => {
      const fileDate = parseISO(f.replace('.json', ''));
      return isBefore(fileDate, cutoffDate);
    });

    for (const file of filesToRemove) {
      const filePath = path.join(DATA_DIR, file);
      if (fs.existsSync(filePath)) {
        console.log(`  Removing old file: ${file}`);
        fs.unlinkSync(filePath);
      }
      const idx = index.repos[repo].files.indexOf(file);
      if (idx > -1) index.repos[repo].files.splice(idx, 1);
    }
  }

  writeIndex(index);
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
