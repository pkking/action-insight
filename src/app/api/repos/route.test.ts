import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('/api/repos', () => {
  it('returns repositories from etl/repos.yaml instead of data fixtures', async () => {
    const response = await GET();
    const body = (await response.json()) as {
      repos: Array<{ owner: string; repo: string; key: string }>;
    };

    expect(body.repos.map((repo) => repo.key)).toEqual([
      'sgl-project/sglang',
      'tile-ai/tilelang-ascend',
      'triton-lang/triton-ascend',
      'verl-project/verl',
      'vllm-project/vllm-ascend',
    ]);
    expect(body.repos.map((repo) => repo.key)).not.toContain('acme/widgets');
    expect(body.repos.map((repo) => repo.key)).not.toContain('boundary-retention-test/widgets');
  });
});
