import { describe, expect, it } from 'vitest';

import { parseCollectCliOptions, resolveTargetRepos } from './collect-options';

describe('collect option helpers', () => {
  it('parses a forced full backfill with a single target repo', () => {
    expect(parseCollectCliOptions(['--force-full-backfill', '--repo', 'openai/action-insight'])).toEqual({
      forceFullBackfill: true,
      reverse: false,
      repoName: 'openai/action-insight',
    });
  });

  it('supports the short aliases for full backfill and repo selection', () => {
    expect(parseCollectCliOptions(['--full', '-r', 'openai/action-insight'])).toEqual({
      forceFullBackfill: true,
      reverse: false,
      repoName: 'openai/action-insight',
    });
  });

  it('does not treat another flag as a repo value', () => {
    expect(parseCollectCliOptions(['--repo', '--full'])).toEqual({
      forceFullBackfill: true,
      reverse: false,
      repoName: undefined,
    });
  });

  it('parses reverse collection mode', () => {
    expect(parseCollectCliOptions(['--reverse'])).toEqual({
      forceFullBackfill: false,
      reverse: true,
      repoName: undefined,
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
