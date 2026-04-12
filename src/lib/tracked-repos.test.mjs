import { describe, expect, it } from 'vitest';

import {
  parseTrackedReposYaml,
  resolveTrackedRepo,
  buildRepoSearchParams,
} from './tracked-repos.js';

describe('tracked repo helpers', () => {
  it('parseTrackedReposYaml returns tracked repo records from repos.yaml content', () => {
    const repos = parseTrackedReposYaml(`
repos:
  - vllm-project/vllm-ascend
  - sgl-project/sglang
  - tile-ai/tilelang-ascend
  - verl-project/verl
  - openai/action-insight
`);

    expect(repos).toEqual([
      {
        owner: 'vllm-project',
        repo: 'vllm-ascend',
        slug: 'vllm-project/vllm-ascend',
        label: 'vllm-project/vllm-ascend',
      },
      {
        owner: 'sgl-project',
        repo: 'sglang',
        slug: 'sgl-project/sglang',
        label: 'sgl-project/sglang',
      },
      {
        owner: 'tile-ai',
        repo: 'tilelang-ascend',
        slug: 'tile-ai/tilelang-ascend',
        label: 'tile-ai/tilelang-ascend',
      },
      {
        owner: 'verl-project',
        repo: 'verl',
        slug: 'verl-project/verl',
        label: 'verl-project/verl',
      },
      {
        owner: 'openai',
        repo: 'action-insight',
        slug: 'openai/action-insight',
        label: 'openai/action-insight',
      },
    ]);
  });

  it('resolveTrackedRepo prefers a valid URL selection and falls back to the first tracked repo', () => {
    const repos = parseTrackedReposYaml(`
repos:
  - vllm-project/vllm-ascend
  - openai/action-insight
`);

    expect(resolveTrackedRepo(repos, 'openai', 'action-insight').slug).toBe('openai/action-insight');
    expect(resolveTrackedRepo(repos, 'bad', 'input').slug).toBe('vllm-project/vllm-ascend');
    expect(resolveTrackedRepo(repos, null, null).slug).toBe('vllm-project/vllm-ascend');
  });

  it('buildRepoSearchParams preserves existing filters while updating the selected repo', () => {
    const params = buildRepoSearchParams(
      new URLSearchParams('days=30&filterName=npu&sortField=date'),
      { owner: 'openai', repo: 'action-insight' }
    );

    expect(params.get('owner')).toBe('openai');
    expect(params.get('repo')).toBe('action-insight');
    expect(params.get('days')).toBe('30');
    expect(params.get('filterName')).toBe('npu');
    expect(params.get('sortField')).toBe('date');
  });
});
