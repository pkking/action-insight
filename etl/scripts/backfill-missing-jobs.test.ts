import { describe, expect, it } from 'vitest';

import { buildMissingAttemptsQuery } from './backfill-missing-jobs';

describe('buildMissingAttemptsQuery', () => {
  it('includes newly configured workflow files even when stored attempts are not tracked yet', () => {
    const sql = buildMissingAttemptsQuery(['nightly-npu.yml', 'nightly-nvidia.yml']);

    expect(sql).toContain('(wa.tracked = 1 OR r.workflow_file IN ($3,$4))');
  });

  it('uses only tracked attempts when no workflow files are configured', () => {
    const sql = buildMissingAttemptsQuery([]);

    expect(sql).toContain('(wa.tracked = 1)');
  });
});
