import { describe, expect, it } from 'vitest';

import { getRepoNames, parseReposConfig } from './repos-config';

describe('repos config parser', () => {
  it('parses repo workflow rules and defaults', () => {
    const config = parseReposConfig(`
defaults:
  steps_min_workflow_duration_seconds: 600
repos:
  - repo: acme/widgets
    steps_min_workflow_duration_seconds: 900
    workflows:
      - file: test.yml
        ref: main
        steps_min_workflow_duration_seconds: 1200
      - file: release.yml
        ref: release/*
`);

    expect(getRepoNames(config)).toEqual(['acme/widgets']);
    expect(config.defaults?.stepsMinWorkflowDurationSeconds).toBe(600);
    expect(config.repos[0]).toMatchObject({
      repo: 'acme/widgets',
      stepsMinWorkflowDurationSeconds: 900,
      workflows: [
        { file: 'test.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 1200 },
        { file: 'release.yml', ref: 'release/*' },
      ],
    });
  });

  it('parses a Buildkite-only collection source', () => {
    const config = parseReposConfig(`
repos:
  - repo: acme/widgets
    github_actions: false
    buildkite_pipelines:
      - organization: acme-ci
        pipeline: widgets-test
`, { requireWorkflows: true });

    expect(config.repos[0]).toMatchObject({
      repo: 'acme/widgets',
      workflows: [],
      githubActions: false,
      buildkitePipelines: [{ organization: 'acme-ci', pipeline: 'widgets-test' }],
    });
  });

  it('rejects repos without a GitHub workflow or Buildkite pipeline when required', () => {
    expect(() =>
      parseReposConfig(
        `
repos:
  - repo: acme/widgets
`,
        { requireWorkflows: true },
      ),
    ).toThrow('must include at least one workflows or buildkite_pipelines rule');
  });

  it('rejects duplicate Buildkite pipelines', () => {
    expect(() => parseReposConfig(`
repos:
  - repo: acme/widgets
    buildkite_pipelines:
      - organization: acme-ci
        pipeline: widgets-test
      - organization: ACME-CI
        pipeline: WIDGETS-TEST
`)).toThrow('Duplicate Buildkite pipeline');
  });

  it('rejects workflow paths as file-name rules', () => {
    expect(() =>
      parseReposConfig(`
repos:
  - repo: acme/widgets
    workflows:
      - file: .github/workflows/ci.yml
`),
    ).toThrow('must be a workflow file basename');
  });

  it('rejects workflow name rules', () => {
    expect(() =>
      parseReposConfig(`
repos:
  - repo: acme/widgets
    workflows:
      - name: CI
`),
    ).toThrow('name is not supported');
  });

  it('rejects workflow name strings', () => {
    expect(() =>
      parseReposConfig(`
repos:
  - repo: acme/widgets
    workflows:
      - CI
`),
    ).toThrow('must be an object with file');
  });

  it('rejects non-array workflows fields', () => {
    expect(() =>
      parseReposConfig(`
repos:
  - repo: acme/widgets
    workflows: ci.yml
`),
    ).toThrow('workflows must be an array');
  });

  it('rejects case-insensitive duplicate repo entries', () => {
    expect(() =>
      parseReposConfig(`
repos:
  - repo: acme/widgets
    workflows:
      - file: ci.yml
  - repo: Acme/Widgets
    workflows:
      - file: ci.yml
`),
    ).toThrow('Duplicate repo entry');
  });

  it('keeps legacy string repo entries readable when workflows are not required', () => {
    const config = parseReposConfig(`
repos:
  - acme/widgets
`);

    expect(getRepoNames(config)).toEqual(['acme/widgets']);
  });
});
