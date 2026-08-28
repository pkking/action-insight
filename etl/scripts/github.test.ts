import { describe, expect, it } from 'vitest';

import { resolveGitHubTokens } from './github';

describe('resolveGitHubTokens', () => {
  it('uses the token file and gh auth token without duplicates', () => {
    expect(resolveGitHubTokens({
      cwd: '/work',
      env: {},
      readFile: () => 'file-token\n' as never,
      ghAuthToken: () => 'gh-token\n',
    })).toEqual(['file-token', 'gh-token']);
  });

  it('retains the CI environment token as a fallback', () => {
    expect(resolveGitHubTokens({
      env: { GITHUB_TOKEN: 'ci-token' },
      readFile: () => { throw new Error('missing'); },
      ghAuthToken: () => { throw new Error('not logged in'); },
    })).toEqual(['ci-token']);
  });
});
