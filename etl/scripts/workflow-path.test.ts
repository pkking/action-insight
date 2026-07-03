import { describe, expect, it } from 'vitest';

import { isGlobRef, matchGlobRef, parseWorkflowPath } from './workflow-path';

describe('parseWorkflowPath', () => {
  it('parses a full workflow path with ref', () => {
    expect(parseWorkflowPath('.github/workflows/ci.yml@main')).toEqual({
      file: 'ci.yml',
      ref: 'main',
      status: 'ok',
    });
  });

  it('parses a yaml extension with ref', () => {
    expect(parseWorkflowPath('.github/workflows/release.yaml@release/1')).toEqual({
      file: 'release.yaml',
      ref: 'release/1',
      status: 'ok',
    });
  });

  it('reports ref unavailable when the path has no ref segment', () => {
    expect(parseWorkflowPath('.github/workflows/ci.yml')).toEqual({
      file: 'ci.yml',
      status: 'ref_unavailable',
    });
  });

  it('reports ref unavailable when the ref segment is empty', () => {
    expect(parseWorkflowPath('.github/workflows/ci.yml@')).toEqual({
      file: 'ci.yml',
      status: 'ref_unavailable',
    });
  });

  it('extracts the basename from a nested workflow path', () => {
    expect(parseWorkflowPath('.github/workflows/sub/ci.yml@main')).toEqual({
      file: 'ci.yml',
      ref: 'main',
      status: 'ok',
    });
  });

  it('reports file unavailable for a non-workflow string', () => {
    expect(parseWorkflowPath('not a path')).toEqual({ status: 'file_unavailable' });
  });

  it('reports file unavailable for empty, null, and undefined input', () => {
    expect(parseWorkflowPath(undefined)).toEqual({ status: 'file_unavailable' });
    expect(parseWorkflowPath('')).toEqual({ status: 'file_unavailable' });
    expect(parseWorkflowPath(null)).toEqual({ status: 'file_unavailable' });
    expect(parseWorkflowPath(42)).toEqual({ status: 'file_unavailable' });
  });

  it('does not infer a file from a workflow name', () => {
    expect(parseWorkflowPath('CI')).toEqual({ status: 'file_unavailable' });
  });
});

describe('ref glob matching', () => {
  it('detects glob refs', () => {
    expect(isGlobRef('release/*')).toBe(true);
    expect(isGlobRef('main')).toBe(false);
  });

  it('matches a single-segment glob', () => {
    expect(matchGlobRef('release/*', 'release/1')).toBe(true);
    expect(matchGlobRef('release/*', 'release/2.0')).toBe(true);
  });

  it('does not match across path segments', () => {
    expect(matchGlobRef('release/*', 'release/a/b')).toBe(false);
  });

  it('requires full anchoring for exact refs expressed as globs', () => {
    expect(matchGlobRef('main', 'main')).toBe(true);
    expect(matchGlobRef('main', 'mainline')).toBe(false);
  });
});
