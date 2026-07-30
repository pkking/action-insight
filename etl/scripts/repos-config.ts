import yaml from 'js-yaml';

export interface WorkflowRule {
  file: string;
  ref?: string;
  stepsMinWorkflowDurationSeconds?: number;
}

export interface BuildkitePipelineRule {
  organization: string;
  pipeline: string;
}

export interface RepoConfigEntry {
  repo: string;
  workflows: WorkflowRule[];
  githubActions?: boolean;
  buildkitePipelines?: BuildkitePipelineRule[];
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
const BUILDKITE_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function normalizeBuildkitePipeline(value: unknown, path: string): BuildkitePipelineRule {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object with organization and pipeline`);
  }
  const organization = typeof value.organization === 'string' ? value.organization.trim() : '';
  const pipeline = typeof value.pipeline === 'string' ? value.pipeline.trim() : '';
  if (!BUILDKITE_SLUG_PATTERN.test(organization)) {
    throw new Error(`${path}.organization must be a Buildkite organization slug`);
  }
  if (!BUILDKITE_SLUG_PATTERN.test(pipeline)) {
    throw new Error(`${path}.pipeline must be a Buildkite pipeline slug`);
  }
  return { organization, pipeline };
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
    return { repo, workflows: [], githubActions: true, buildkitePipelines: [] };
  }

  if (!isRecord(value)) {
    throw new Error(`${path} must be a repo string or object`);
  }

  const repo = typeof value.repo === 'string' ? value.repo.trim() : '';
  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new Error(`${path}.repo must use owner/repo format`);
  }

  if (value.github_actions !== undefined && typeof value.github_actions !== 'boolean') {
    throw new Error(`${path}.github_actions must be a boolean`);
  }
  const githubActions = value.github_actions !== false;

  if (value.workflows !== undefined && !Array.isArray(value.workflows)) {
    throw new Error(`${path}.workflows must be an array`);
  }
  const workflows = Array.isArray(value.workflows)
    ? value.workflows.map((workflow, workflowIndex) => normalizeWorkflowRule(workflow, `${path}.workflows[${workflowIndex}]`))
    : [];
  if (value.buildkite_pipelines !== undefined && !Array.isArray(value.buildkite_pipelines)) {
    throw new Error(`${path}.buildkite_pipelines must be an array`);
  }
  const buildkitePipelines = Array.isArray(value.buildkite_pipelines)
    ? value.buildkite_pipelines.map((pipeline, pipelineIndex) => normalizeBuildkitePipeline(pipeline, `${path}.buildkite_pipelines[${pipelineIndex}]`))
    : [];

  if (options.requireWorkflows && !((githubActions && workflows.length > 0) || buildkitePipelines.length > 0)) {
    throw new Error(`${path} must include at least one workflows or buildkite_pipelines rule`);
  }

  return {
    repo,
    workflows,
    githubActions,
    buildkitePipelines,
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

    const seenBuildkitePipelines = new Set<string>();
    for (const pipeline of entry.buildkitePipelines ?? []) {
      const key = `${pipeline.organization.toLowerCase()}/${pipeline.pipeline.toLowerCase()}`;
      if (seenBuildkitePipelines.has(key)) {
        throw new Error(`Duplicate Buildkite pipeline for ${entry.repo}: ${key}`);
      }
      seenBuildkitePipelines.add(key);
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
