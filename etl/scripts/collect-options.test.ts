import { describe, expect, it } from 'vitest';

import { parseCollectCliOptions, resolveTargetRepos } from './collect-options';

describe('collect option helpers', () => {
  it('parses a forced full backfill with a single target repo', () => {
    expect(parseCollectCliOptions(['--force-full-backfill', '--repo', 'openai/action-insight'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: true,
      forward: false,
      help: false,
      reverse: true,
      repoName: 'openai/action-insight',
      skipJobs: false,
    });
  });

  it('supports the short aliases for full backfill and repo selection', () => {
    expect(parseCollectCliOptions(['--full', '-r', 'openai/action-insight'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: true,
      forward: false,
      help: false,
      reverse: true,
      repoName: 'openai/action-insight',
      skipJobs: false,
    });
  });

  it('does not treat another flag as a repo value', () => {
    expect(parseCollectCliOptions(['--repo', '--full'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: true,
      forward: false,
      help: false,
      reverse: true,
      repoName: undefined,
      skipJobs: false,
    });
  });

  it('parses reverse collection mode (explicit, already default)', () => {
    expect(parseCollectCliOptions(['--reverse'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: false,
      forward: false,
      help: false,
      reverse: true,
      repoName: undefined,
      skipJobs: false,
    });
  });

  it('parses forward collection mode (legacy oldest-first)', () => {
    expect(parseCollectCliOptions(['--forward'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: false,
      forward: true,
      help: false,
      reverse: false,
      repoName: undefined,
      skipJobs: false,
    });
  });

  it('lets the last explicit direction win', () => {
    expect(parseCollectCliOptions(['--forward', '--reverse'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: false,
      forward: false,
      help: false,
      reverse: true,
      repoName: undefined,
      skipJobs: false,
    });

    expect(parseCollectCliOptions(['--reverse', '--forward'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: false,
      forward: true,
      help: false,
      reverse: false,
      repoName: undefined,
      skipJobs: false,
    });
  });

  it('parses a scoped collection window via --days', () => {
    expect(parseCollectCliOptions(['--days', '14', '--repo', 'vllm-project/vllm-ascend'])).toEqual({
      collectDays: 14,
      forceFullBackfill: false,
      forward: false,
      help: false,
      reverse: true,
      repoName: 'vllm-project/vllm-ascend',
      skipJobs: false,
    });
  });

  it('ignores a non-numeric --days value', () => {
    expect(parseCollectCliOptions(['--days', 'abc'])).toEqual({
      collectDays: undefined,
      forceFullBackfill: false,
      forward: false,
      help: false,
      reverse: true,
      repoName: undefined,
      skipJobs: false,
    });
  });

  it('prefers an explicit repo over configured repos', () => {
    expect(resolveTargetRepos(['vllm-project/vllm-ascend', 'openai/action-insight'], 'openai/action-insight')).toEqual([
      'openai/action-insight',
    ]);
  });

  it('keeps configured repos when no explicit repo is provided', () => {
    expect(resolveTargetRepos(['vllm-project/vllm-ascend', 'openai/action-insight'], undefined)).toEqual([
      'vllm-project/vllm-ascend',
      'openai/action-insight',
    ]);
  });
});
