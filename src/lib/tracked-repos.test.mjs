import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTrackedReposYaml,
  resolveTrackedRepo,
  buildRepoSearchParams,
} from './tracked-repos.js';

test('parseTrackedReposYaml returns tracked repo records from repos.yaml content', () => {
  const repos = parseTrackedReposYaml(`
repos:
  - vllm-project/vllm-ascend
  - sgl-project/sglang
  - tile-ai/tilelang-ascend
  - verl-project/verl
  - openai/action-insight
`);

  assert.deepEqual(repos, [
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

test('resolveTrackedRepo prefers a valid URL selection and falls back to the first tracked repo', () => {
  const repos = parseTrackedReposYaml(`
repos:
  - vllm-project/vllm-ascend
  - openai/action-insight
`);

  assert.equal(resolveTrackedRepo(repos, 'openai', 'action-insight').slug, 'openai/action-insight');
  assert.equal(resolveTrackedRepo(repos, 'bad', 'input').slug, 'vllm-project/vllm-ascend');
  assert.equal(resolveTrackedRepo(repos, null, null).slug, 'vllm-project/vllm-ascend');
});

test('buildRepoSearchParams preserves existing filters while updating the selected repo', () => {
  const params = buildRepoSearchParams(
    new URLSearchParams('days=30&filterName=npu&sortField=date'),
    { owner: 'openai', repo: 'action-insight' }
  );

  assert.equal(params.get('owner'), 'openai');
  assert.equal(params.get('repo'), 'action-insight');
  assert.equal(params.get('days'), '30');
  assert.equal(params.get('filterName'), 'npu');
  assert.equal(params.get('sortField'), 'date');
});
