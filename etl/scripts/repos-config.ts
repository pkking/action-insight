import yaml from 'js-yaml';

export interface WorkflowRule {
  file: string;
  ref?: string;
  stepsMinWorkflowDurationSeconds?: number;
}

export interface RepoConfigEntry {
  repo: string;
  workflows: WorkflowRule[];
  stepsMinWorkflowDurationSeconds?: number;
}

export interface ReposConfig {
  defaults?: {
    stepsMinWorkflowDurationSeconds?: number;
  };
  repos: RepoConfigEntry[];
}

export interface ParseReposConfigOptions {
  requireWorkflows?: boolean;
}

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_FILE_PATTERN = /^[^/\\]+\.ya?ml$/;
const REF_PATTERN = /^[A-Za-z0-9._/*-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveSeconds(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${path} must be a positive integer number of seconds`);
  }
  return Number(value);
}

function normalizeWorkflowRule(value: unknown, path: string): WorkflowRule {
  if (typeof value === 'string') {
    throw new Error(`${path} must be an object with file, not a workflow name string`);
  }

  if (!isRecord(value)) {
    throw new Error(`${path} must be an object with file`);
  }

  const file = typeof value.file === 'string' ? value.file.trim() : undefined;
  const ref = typeof value.ref === 'string' ? value.ref.trim() : undefined;

  if (typeof value.name === 'string') {
    throw new Error(`${path}.name is not supported; use workflow file basename`);
  }

  if (!file) {
    throw new Error(`${path} must include file`);
  }
  if (!WORKFLOW_FILE_PATTERN.test(file)) {
    throw new Error(`${path}.file must be a workflow file basename like ci.yml, not a path`);
  }
  if (ref === '') {
    throw new Error(`${path}.ref must not be empty`);
  }
  if (ref && !REF_PATTERN.test(ref)) {
    throw new Error(`${path}.ref must be an exact ref or glob using letters, numbers, _, -, ., /, and *`);
  }

  return {
    file,
    ...(ref ? { ref } : {}),
    stepsMinWorkflowDurationSeconds: readPositiveSeconds(
      value.steps_min_workflow_duration_seconds,
      `${path}.steps_min_workflow_duration_seconds`,
    ),
  };
}

function normalizeRepoEntry(value: unknown, index: number, options: ParseReposConfigOptions): RepoConfigEntry {
  const path = `repos[${index}]`;

  if (typeof value === 'string') {
    const repo = value.trim();
    if (!OWNER_REPO_PATTERN.test(repo)) {
      throw new Error(`${path} must use owner/repo format`);
    }
    if (options.requireWorkflows) {
      throw new Error(`${path} must specify workflows; use { repo, workflows }`);
    }
    return { repo, workflows: [] };
  }

  if (!isRecord(value)) {
    throw new Error(`${path} must be a repo string or object`);
  }

  const repo = typeof value.repo === 'string' ? value.repo.trim() : '';
  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new Error(`${path}.repo must use owner/repo format`);
  }

  if (value.workflows !== undefined && !Array.isArray(value.workflows)) {
    throw new Error(`${path}.workflows must be an array`);
  }
  const workflows = Array.isArray(value.workflows)
    ? value.workflows.map((workflow, workflowIndex) => normalizeWorkflowRule(workflow, `${path}.workflows[${workflowIndex}]`))
    : [];

  if (options.requireWorkflows && workflows.length === 0) {
    throw new Error(`${path}.workflows must include at least one workflow rule`);
  }

  return {
    repo,
    workflows,
    stepsMinWorkflowDurationSeconds: readPositiveSeconds(
      value.steps_min_workflow_duration_seconds,
      `${path}.steps_min_workflow_duration_seconds`,
    ),
  };
}

export function parseReposConfig(content: string, options: ParseReposConfigOptions = {}): ReposConfig {
  const parsed = yaml.load(content);
  if (!isRecord(parsed)) {
    throw new Error('repos.yaml must contain a YAML object');
  }

  const reposValue = parsed.repos;
  if (!Array.isArray(reposValue)) {
    throw new Error('repos.yaml must include repos as a list');
  }

  const defaults = isRecord(parsed.defaults)
    ? {
        stepsMinWorkflowDurationSeconds: readPositiveSeconds(
          parsed.defaults.steps_min_workflow_duration_seconds,
          'defaults.steps_min_workflow_duration_seconds',
        ),
      }
    : undefined;

  const repos = reposValue.map((entry, index) => normalizeRepoEntry(entry, index, options));
  const seenRepos = new Set<string>();
  for (const entry of repos) {
    const repoLower = entry.repo.toLowerCase();
    if (seenRepos.has(repoLower)) {
      throw new Error(`Duplicate repo entry: ${entry.repo}`);
    }
    seenRepos.add(repoLower);

    const seenWorkflowKeys = new Set<string>();
    for (const workflow of entry.workflows) {
      const key = `file:${workflow.file}:ref:${workflow.ref ?? '*'}`;
      if (seenWorkflowKeys.has(key)) {
        throw new Error(`Duplicate workflow rule for ${entry.repo}: ${key}`);
      }
      seenWorkflowKeys.add(key);
    }
  }

  return {
    ...(defaults ? { defaults } : {}),
    repos,
  };
}

export function getRepoNames(config: ReposConfig): string[] {
  return config.repos.map((entry) => entry.repo);
}
