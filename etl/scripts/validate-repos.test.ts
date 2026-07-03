import { describe, expect, it } from 'vitest';

import { findWorkflowMatches } from './validate-repos';

describe('validate repos online helpers', () => {
  it('includes available workflow files when a configured file is missing', () => {
    const errors = findWorkflowMatches(
      {
        repo: 'acme/widgets',
        workflows: [{ file: 'missing.yml' }],
      },
      [
        { path: '.github/workflows/ci.yml' },
        { path: '.github/workflows/release.yaml' },
      ],
    );

    expect(errors).toEqual([
      'acme/widgets: workflow file did not match any GitHub workflow (file=missing.yml). Available workflow files: ci.yml, release.yaml',
    ]);
  });
});
