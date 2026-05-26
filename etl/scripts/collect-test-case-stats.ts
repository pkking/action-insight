/**
 * ETL script: Collect test case statistics (Ascend vs NVIDIA) per repo.
 *
 * Clones the target repo, parses workflow YAML files to classify jobs by
 * hardware (via `runs-on:` labels), counts test files referenced by each
 * job's test commands, and upserts results into the `test_case_stats` table.
 *
 * Usage:
 *   npx tsx etl/scripts/collect-test-case-stats.ts --repo owner/repo
 *
 * Environment:
 *   SUPABASE_URL                  Supabase project URL (required)
 *   SUPABASE_SERVICE_ROLE_KEY     Supabase service role key (required)
 *   GITHUB_TOKEN                  GitHub token for authenticated clone (optional)
 *   TEST_CASE_STATS_CACHE_DIR     Cache directory for cloned repos (default: /tmp/action-insight-repos)
 *   VERBOSE                       Enable verbose logging (true or 1)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';
import { format, subDays } from 'date-fns';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERBOSE = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
const CACHE_DIR = process.env.TEST_CASE_STATS_CACHE_DIR || '/tmp/action-insight-repos';

const ASCEND_LABELS = new Set(['npu', 'ascend', 'cann', 'huawei', 'atlas']);
const NVIDIA_LABELS = new Set(['cuda', 'gpu', 'nvidia', 'tesla', 'a100', 'v100', 't4', 'l4', 'l40', 'h100']);

// Safe identifier pattern: alphanumeric, hyphens, underscores only (GitHub owner/repo constraints)
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function validateIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: "${value}". Must match pattern: ${SAFE_IDENTIFIER.source}`);
  }
}

const TEST_COMMAND_PATTERNS = [
  /pytest\s+(.+)/i,
  /python\s+(-m\s+pytest|unittest|pytest)\s+(.+)/i,
  /python\s+(-m\s+unittest)\s+(.+)/i,
  /unittest\s+(.+)/i,
  /nosetests\s+(.+)/i,
  /tox\s+(.+)/i,
  /npm\s+test/i,
  /yarn\s+test/i,
  /pnpm\s+test/i,
  /jest\s+(.+)/i,
  /mocha\s+(.+)/i,
  /vitest\s+(.+)/i,
];

const PATH_EXTRACT_PATTERNS = [
  /(?:^|\s)(tests?\/[\w\-/.*]+)/g,
  /(?:^|\s)(test[\w\-/.*]+\.py)/g,
  /(?:^|\s)([\w\-/]*tests?\/[\w\-/.*]+)/g,
];

function log(...args: unknown[]) {
  if (VERBOSE) {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }
}

function info(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] INFO:`, ...args);
}

function warn(...args: unknown[]) {
  console.warn(`[${new Date().toISOString()}] WARN:`, ...args);
}

function error(...args: unknown[]) {
  console.error(`[${new Date().toISOString()}] ERROR:`, ...args);
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  return createClient(supabaseUrl, supabaseKey);
}

async function ensureRepo(supabase: ReturnType<typeof createClient>, owner: string, repo: string): Promise<number> {
  await supabase
    .from('repos')
    .upsert({ owner, repo }, { onConflict: 'owner,repo', ignoreDuplicates: true });

  const { data, error } = await supabase
    .from('repos')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  if (error || !data) {
    throw new Error(`Failed to ensure repository ${owner}/${repo} in Supabase: ${error?.message}`);
  }

  return data.id;
}

async function upsertTestCaseStats(
  supabase: ReturnType<typeof createClient>,
  repoId: number,
  stats: {
    window_start: string;
    window_end: string;
    total_test_cases: number;
    ascend_test_cases: number;
    nvidia_test_cases: number;
  },
): Promise<void> {
  const { error } = await supabase
    .from('test_case_stats')
    .upsert(
      {
        repo_id: repoId,
        window_start: stats.window_start,
        window_end: stats.window_end,
        total_test_cases: stats.total_test_cases,
        ascend_test_cases: stats.ascend_test_cases,
        nvidia_test_cases: stats.nvidia_test_cases,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'repo_id,window_start,window_end' },
    );

  if (error) {
    throw new Error(`Failed to upsert test_case_stats: ${error.message}`);
  }
}

function getRepoDir(owner: string, repo: string): string {
  return path.join(CACHE_DIR, `${owner}-${repo}`);
}

function cloneOrUpdateRepo(owner: string, repo: string): string {
  validateIdentifier(owner, 'owner');
  validateIdentifier(repo, 'repo');

  const repoDir = getRepoDir(owner, repo);
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  if (fs.existsSync(repoDir) && fs.existsSync(path.join(repoDir, '.git'))) {
    info(`Updating existing clone at ${repoDir}...`);
    try {
      execSync('git pull --ff-only', { cwd: repoDir, stdio: VERBOSE ? 'inherit' : 'pipe' });
      info('Repository updated.');
    } catch (err) {
      warn(`git pull failed, trying fetch + reset: ${err instanceof Error ? err.message : String(err)}`);
      execSync('git fetch origin', { cwd: repoDir, stdio: VERBOSE ? 'inherit' : 'pipe' });
      execSync('git reset --hard origin/main', { cwd: repoDir, stdio: VERBOSE ? 'inherit' : 'pipe' });
      info('Repository reset to origin/main.');
    }
  } else {
    info(`Cloning ${owner}/${repo} to ${repoDir}...`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      // Use git config to set credential helper instead of embedding token in URL
      execSync(`git -c http.extraheader="AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}" clone --depth 1 ${repoUrl} ${repoDir}`, { stdio: VERBOSE ? 'inherit' : 'pipe' });
    } else {
      execSync(`git clone --depth 1 ${repoUrl} ${repoDir}`, { stdio: VERBOSE ? 'inherit' : 'pipe' });
    }
    info('Repository cloned.');
  }

  return repoDir;
}

interface WorkflowJob {
  name: string;
  runsOn: string | string[] | null;
  testPaths: string[];
}

function classifyHardware(runsOn: string | string[] | null, jobName: string): 'ascend' | 'nvidia' | 'unknown' {
  const labels: string[] = [];

  if (typeof runsOn === 'string') {
    labels.push(runsOn);
  } else if (Array.isArray(runsOn)) {
    labels.push(...runsOn);
  }

  const jobNameLower = jobName.toLowerCase();

  const allText = [...labels, jobNameLower].join(' ').toLowerCase();

  for (const label of ASCEND_LABELS) {
    if (allText.includes(label)) return 'ascend';
  }
  for (const label of NVIDIA_LABELS) {
    if (allText.includes(label)) return 'nvidia';
  }

  return 'unknown';
}

function extractTestPathsFromStep(runContent: string): string[] {
  const paths: string[] = [];

  for (const pattern of TEST_COMMAND_PATTERNS) {
    const match = runContent.match(pattern);
    if (match) {
      const args = match[2] || match[1] || '';
      if (!args) continue;

      for (const pathPattern of PATH_EXTRACT_PATTERNS) {
        pathPattern.lastIndex = 0;
        let m;
        while ((m = pathPattern.exec(args)) !== null) {
          const extracted = m[1];
          if (extracted && extracted.length > 1) {
            paths.push(extracted);
          }
        }
      }

      const tokens = args.split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith('-') || token.startsWith('$') || token.includes('=')) continue;
        if (token.includes('/') || token.endsWith('.py') || token === 'tests' || token === 'test') {
          const cleaned = token.replace(/[,;:]+$/, '');
          if (cleaned.length > 1) {
            paths.push(cleaned);
          }
        }
      }
    }
  }

  return paths;
}

function parseWorkflowFile(filePath: string): WorkflowJob[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(content) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || !parsed.jobs) {
    return [];
  }

  const jobs = parsed.jobs as Record<string, unknown>;
  const result: WorkflowJob[] = [];

  for (const [jobName, jobConfig] of Object.entries(jobs)) {
    if (!jobConfig || typeof jobConfig !== 'object') continue;

    const job = jobConfig as Record<string, unknown>;
    const runsOn = job['runs-on'] as string | string[] | null;

    const testPaths: string[] = [];
    const steps = job.steps as unknown[] | undefined;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const s = step as Record<string, unknown>;
        const runContent = s.run as string | undefined;
        if (runContent) {
          const extracted = extractTestPathsFromStep(runContent);
          testPaths.push(...extracted);
        }
      }
    }

    result.push({
      name: jobName,
      runsOn,
      testPaths: [...new Set(testPaths)],
    });
  }

  return result;
}

function countTestFiles(repoDir: string, testPaths: string[]): number {
  const matchedFiles = new Set<string>();

  for (const testPath of testPaths) {
    const fullPath = path.join(repoDir, testPath);

    try {
      if (!fs.existsSync(fullPath)) {
        const globMatches = globSync(testPath, { cwd: repoDir, absolute: true });
        for (const match of globMatches) {
          if (match.endsWith('.py') && (match.includes('/test_') || match.includes('_test.py'))) {
            matchedFiles.add(match);
          }
        }
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const files = findTestFilesInDir(fullPath);
        for (const f of files) {
          matchedFiles.add(f);
        }
      } else if (fullPath.endsWith('.py')) {
        const basename = path.basename(fullPath);
        if (basename.startsWith('test_') || basename.endsWith('_test.py')) {
          matchedFiles.add(fullPath);
        }
      }
    } catch {
      log(`  Skipping inaccessible path: ${testPath}`);
    }
  }

  return matchedFiles.size;
}

function findTestFilesInDir(dir: string): string[] {
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '__pycache__', '.tox', '.venv', 'venv', '.mypy_cache'].includes(entry.name)) {
          continue;
        }
        results.push(...findTestFilesInDir(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        if (entry.name.startsWith('test_') || entry.name.endsWith('_test.py')) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // intentionally empty - skip unreadable directories
  }

  return results;
}

function globSync(pattern: string, options: { cwd: string; absolute: boolean }): string[] {
  const { cwd, absolute } = options;
  const results: string[] = [];

  // Handle simple ** patterns
  const regexPattern = pattern
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexPattern}$`);

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, fullPath);

        if (regex.test(relativePath)) {
          results.push(absolute ? fullPath : relativePath);
        }

        if (entry.isDirectory() && !['.git', 'node_modules', '__pycache__'].includes(entry.name)) {
          walk(fullPath);
        }
      }
    } catch {
      // intentionally empty - skip inaccessible directories
    }
  }

  walk(cwd);
  return results;
}

interface TestCaseStatsResult {
  totalTestCases: number;
  ascendTestCases: number;
  nvidiaTestCases: number;
  jobDetails: Array<{
    jobName: string;
    hardware: string;
    testFileCount: number;
    testPaths: string[];
  }>;
}

function collectTestCaseStats(repoDir: string, workflowJobs: WorkflowJob[]): TestCaseStatsResult {
  let ascendTestCases = 0;
  let nvidiaTestCases = 0;
  const jobDetails: Array<{ jobName: string; hardware: string; testFileCount: number; testPaths: string[] }> = [];

  for (const job of workflowJobs) {
    const hardware = classifyHardware(job.runsOn, job.name);

    if (hardware === 'unknown' || job.testPaths.length === 0) {
      log(`  Job "${job.name}": hardware=${hardware}, testPaths=${job.testPaths.length} (skipped)`);
      continue;
    }

    const testFileCount = countTestFiles(repoDir, job.testPaths);

    if (hardware === 'ascend') {
      ascendTestCases += testFileCount;
    } else if (hardware === 'nvidia') {
      nvidiaTestCases += testFileCount;
    }

    jobDetails.push({
      jobName: job.name,
      hardware,
      testFileCount,
      testPaths: job.testPaths,
    });

    log(`  Job "${job.name}": hardware=${hardware}, testFiles=${testFileCount}, paths=${job.testPaths.join(', ')}`);
  }

  return {
    totalTestCases: ascendTestCases + nvidiaTestCases,
    ascendTestCases,
    nvidiaTestCases,
    jobDetails,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let repoArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--repo' || argv[i] === '-r') && argv[i + 1]) {
      repoArg = argv[i + 1];
      i++;
    }
  }

  if (!repoArg) {
    console.error('Usage: npx tsx etl/scripts/collect-test-case-stats.ts --repo owner/repo');
    console.error('');
    console.error('Environment Variables:');
    console.error('  SUPABASE_URL                  Supabase project URL (required)');
    console.error('  SUPABASE_SERVICE_ROLE_KEY     Supabase service role key (required)');
    console.error('  GITHUB_TOKEN                  GitHub token for authenticated clone (optional)');
    console.error('  TEST_CASE_STATS_CACHE_DIR     Cache directory (default: /tmp/action-insight-repos)');
    console.error('  VERBOSE                       Enable verbose logging (true or 1)');
    process.exit(1);
  }

  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    error(`Invalid repo format: ${repoArg}. Expected owner/repo`);
    process.exit(1);
  }

  info(`Collecting test case stats for ${owner}/${repoName}...`);

  let repoDir: string;
  try {
    repoDir = cloneOrUpdateRepo(owner, repoName);
  } catch (err) {
    error(`Failed to clone/update repository: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const workflowsDir = path.join(repoDir, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    warn(`No .github/workflows directory found in ${repoDir}`);
    process.exit(0);
  }

  const workflowFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  info(`Found ${workflowFiles.length} workflow file(s).`);

  const allJobs: WorkflowJob[] = [];
  for (const wf of workflowFiles) {
    const wfPath = path.join(workflowsDir, wf);
    const jobs = parseWorkflowFile(wfPath);
    allJobs.push(...jobs);
    log(`  Parsed ${wf}: ${jobs.length} job(s)`);
  }

  info(`Total jobs parsed across all workflows: ${allJobs.length}`);

  const stats = collectTestCaseStats(repoDir, allJobs);

  info(`Results: total=${stats.totalTestCases}, ascend=${stats.ascendTestCases}, nvidia=${stats.nvidiaTestCases}`);

  if (VERBOSE && stats.jobDetails.length > 0) {
    console.log('\nJob details:');
    for (const jd of stats.jobDetails) {
      console.log(`  ${jd.jobName}: ${jd.hardware} (${jd.testFileCount} test files)`);
    }
    console.log('');
  }

  const supabase = getSupabaseClient();

  let repoId: number;
  try {
    repoId = await ensureRepo(supabase, owner, repoName);
  } catch (err) {
    error(`Failed to ensure repo in Supabase: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const today = new Date();
  const windowEnd = format(today, 'yyyy-MM-dd');
  const windowStart = format(subDays(today, 90), 'yyyy-MM-dd');

  try {
    await upsertTestCaseStats(supabase, repoId, {
      window_start: windowStart,
      window_end: windowEnd,
      total_test_cases: stats.totalTestCases,
      ascend_test_cases: stats.ascendTestCases,
      nvidia_test_cases: stats.nvidiaTestCases,
    });
    info(`Upserted test_case_stats for ${owner}/${repoName} (window: ${windowStart} to ${windowEnd})`);
  } catch (err) {
    error(`Failed to write to Supabase: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  info('Done!');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    error(err);
    process.exit(1);
  });
}

export { main, collectTestCaseStats, classifyHardware, parseWorkflowFile, extractTestPathsFromStep };
