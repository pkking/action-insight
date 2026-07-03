import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Octokit } from 'octokit';

import { parseReposConfig, type ReposConfig, type RepoConfigEntry } from './repos-config';

interface CliOptions {
  online: boolean;
  configPath: string;
  help: boolean;
}

interface GitHubWorkflow {
  name?: string | null;
  path?: string | null;
}

const HELP = `Usage: npx tsx etl/scripts/validate-repos.ts [options]

Validate ETL repository and workflow configuration.

Options:
  --online              Verify repos and configured workflows against GitHub.
  --config <path>       Config path (default: etl/repos.yaml).
  --help, -h            Show this help.
`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.join(__dirname, '../repos.yaml');

function parseCliOptions(argv: string[]): CliOptions {
  let online = false;
  let configPath = DEFAULT_CONFIG_PATH;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--online') {
      online = true;
      continue;
    }

    if (arg === '--config') {
      if (!next || next.startsWith('-')) {
        throw new Error('--config requires a path');
      }
      configPath = path.resolve(next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { online, configPath, help };
}

function formatWorkflowRule(rule: { file: string; ref?: string }): string {
  return rule.ref ? `file=${rule.file}, ref=${rule.ref}` : `file=${rule.file}`;
}

export function findWorkflowMatches(repo: RepoConfigEntry, workflows: GitHubWorkflow[]): string[] {
  const workflowFiles = Array.from(new Set(
    workflows
      .map((workflow) => workflow.path)
      .filter((workflowPath): workflowPath is string => typeof workflowPath === 'string' && workflowPath.length > 0)
      .map((workflowPath) => path.basename(workflowPath)),
  )).sort((left, right) => left.localeCompare(right));
  const workflowFileSet = new Set(workflowFiles);
  const availableFiles = workflowFiles.length > 0 ? workflowFiles.join(', ') : '(none returned by GitHub)';

  const errors: string[] = [];
  for (const rule of repo.workflows) {
    if (!workflowFileSet.has(rule.file)) {
      errors.push(
        `${repo.repo}: workflow file did not match any GitHub workflow (${formatWorkflowRule(rule)}). Available workflow files: ${availableFiles}`,
      );
    }
  }

  return errors;
}

async function fetchAllWorkflows(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<GitHubWorkflow[]> {
  const workflows: GitHubWorkflow[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows', {
      owner,
      repo,
      per_page: 100,
      page,
    });
    const pageWorkflows = (response.data as { workflows?: GitHubWorkflow[] }).workflows ?? [];
    workflows.push(...pageWorkflows);
    if (pageWorkflows.length < 100) break;
    page += 1;
  }

  return workflows;
}

async function validateOnline(config: ReposConfig): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return ['GITHUB_TOKEN is required for online repository validation'];
  }

  const octokit = new Octokit({ auth: token });
  const errors: string[] = [];

  for (const entry of config.repos) {
    const [owner, repo] = entry.repo.split('/');
    try {
      await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      const workflows = await fetchAllWorkflows(octokit, owner, repo);
      errors.push(...findWorkflowMatches(entry, workflows));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${entry.repo}: GitHub validation failed: ${message}`);
    }
  }

  return errors;
}

export async function validateReposConfigFile(options: CliOptions): Promise<void> {
  const content = fs.readFileSync(options.configPath, 'utf8');
  const config = parseReposConfig(content, { requireWorkflows: true });
  const errors = options.online ? await validateOnline(config) : [];

  if (errors.length > 0) {
    throw new Error(`Repository config validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }

  console.log(
    `Validated ${config.repos.length} repo(s) and ${config.repos.reduce((sum, repo) => sum + repo.workflows.length, 0)} workflow rule(s).`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.help) {
    console.log(HELP.trim());
    return;
  }

  await validateReposConfigFile(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
