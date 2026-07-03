import { describe, expect, it } from 'vitest';

import type { ReposConfig, RepoConfigEntry } from './repos-config';
import { parseWorkflowPath } from './workflow-path';
import {
  DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS,
  resolveWorkflowMatch,
  stepPolicyHash,
} from './workflow-match';

function repoEntry(workflows: RepoConfigEntry['workflows'], extra: Partial<RepoConfigEntry> = {}): RepoConfigEntry {
  return { repo: 'acme/widgets', workflows, ...extra };
}

function config(repo: RepoConfigEntry, defaults?: ReposConfig['defaults']): ReposConfig {
  return { repos: [repo], ...(defaults ? { defaults } : {}) };
}

function matchFor(yamlPath: string, repo: RepoConfigEntry, defaults?: ReposConfig['defaults']) {
  return resolveWorkflowMatch(config(repo, defaults), repo, parseWorkflowPath(yamlPath));
}

describe('workflow matching precedence', () => {
  it('matches an exact ref over a glob and file-only rule', () => {
    const repo = repoEntry([
      { file: 'ci.yml', ref: 'main' },
      { file: 'ci.yml', ref: 'release/*' },
      { file: 'ci.yml' },
    ]);
    const m = matchFor('.github/workflows/ci.yml@main', repo);
    expect(m.tracked).toBe(true);
    expect(m.kind).toBe('exact_ref');
    expect(m.rule?.ref).toBe('main');
  });

  it('matches a glob ref when no exact ref matches', () => {
    const repo = repoEntry([
      { file: 'ci.yml', ref: 'release/*' },
      { file: 'ci.yml' },
    ]);
    const m = matchFor('.github/workflows/ci.yml@release/2', repo);
    expect(m.tracked).toBe(true);
    expect(m.kind).toBe('glob_ref');
  });

  it('matches a file-only rule for any ref', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const m = matchFor('.github/workflows/ci.yml@main', repo);
    expect(m.tracked).toBe(true);
    expect(m.kind).toBe('file_only');
  });

  it('file-only matches a ref-unavailable run', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const m = matchFor('.github/workflows/ci.yml', repo);
    expect(m.tracked).toBe(true);
    expect(m.kind).toBe('file_only');
  });

  it('ref-specific rules do not match a ref-unavailable run', () => {
    const repo = repoEntry([{ file: 'ci.yml', ref: 'main' }]);
    const m = matchFor('.github/workflows/ci.yml', repo);
    expect(m.tracked).toBe(false);
    expect(m.reason).toBe('ref_unavailable_no_match');
  });

  it('rejects ambiguous same-precedence exact-ref matches', () => {
    const repo = repoEntry([
      { file: 'ci.yml', ref: 'main' },
      { file: 'ci.yml', ref: 'main' },
    ]);
    const m = matchFor('.github/workflows/ci.yml@main', repo);
    expect(m.tracked).toBe(false);
    expect(m.reason).toBe('ambiguous');
  });

  it('rejects ambiguous same-precedence file-only matches', () => {
    const repo = repoEntry([{ file: 'ci.yml' }, { file: 'ci.yml' }]);
    const m = matchFor('.github/workflows/ci.yml@main', repo);
    expect(m.tracked).toBe(false);
    expect(m.reason).toBe('ambiguous');
  });

  it('excludes runs without a usable workflow file', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const m = matchFor('CI', repo);
    expect(m.tracked).toBe(false);
    expect(m.reason).toBe('file_unavailable');
  });

  it('does not match a different workflow file', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const m = matchFor('.github/workflows/release.yml@main', repo);
    expect(m.tracked).toBe(false);
    expect(m.reason).toBe('no_match');
  });
});

describe('step threshold override precedence', () => {
  it('uses the workflow exact-ref threshold when set', () => {
    const repo = repoEntry([{ file: 'ci.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 1200 }]);
    expect(matchFor('.github/workflows/ci.yml@main', repo).stepThresholdSeconds).toBe(1200);
  });

  it('falls through to repo threshold then defaults', () => {
    const repo = repoEntry([{ file: 'ci.yml' }], { stepsMinWorkflowDurationSeconds: 900 });
    expect(matchFor('.github/workflows/ci.yml@main', repo).stepThresholdSeconds).toBe(900);
  });

  it('uses defaults when nothing else is set', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    expect(matchFor('.github/workflows/ci.yml@main', repo).stepThresholdSeconds).toBe(
      DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS,
    );
  });

  it('uses configured defaults over the builtin default', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const cfg = config(repo, { stepsMinWorkflowDurationSeconds: 300 });
    expect(resolveWorkflowMatch(cfg, repo, parseWorkflowPath('.github/workflows/ci.yml@main')).stepThresholdSeconds).toBe(300);
  });
});

describe('step policy hash', () => {
  it('is stable for the same match', () => {
    const repo = repoEntry([{ file: 'ci.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 600 }]);
    const a = matchFor('.github/workflows/ci.yml@main', repo);
    const b = matchFor('.github/workflows/ci.yml@main', repo);
    expect(stepPolicyHash(a)).toBe(stepPolicyHash(b));
  });

  it('changes when the threshold changes', () => {
    const repo600 = repoEntry([{ file: 'ci.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 600 }]);
    const repo900 = repoEntry([{ file: 'ci.yml', ref: 'main', stepsMinWorkflowDurationSeconds: 900 }]);
    expect(stepPolicyHash(matchFor('.github/workflows/ci.yml@main', repo600))).not.toBe(
      stepPolicyHash(matchFor('.github/workflows/ci.yml@main', repo900)),
    );
  });

  it('differs between tracked and untracked runs', () => {
    const repo = repoEntry([{ file: 'ci.yml' }]);
    const tracked = matchFor('.github/workflows/ci.yml@main', repo);
    const untracked = matchFor('CI', repo);
    expect(stepPolicyHash(tracked)).not.toBe(stepPolicyHash(untracked));
  });
});
