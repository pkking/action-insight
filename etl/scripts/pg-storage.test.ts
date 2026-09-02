import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/db.ts', () => ({ getDatabaseClient: vi.fn() }));

import { getDatabaseClient } from '../../src/lib/db';
import { persistCollectionWindow } from './pg-storage';

const state = {
  backfillCursor: null,
  historyComplete: true,
  latestDate: '2026-04-18',
  retentionDays: 90,
  lastUpdated: '2026-04-18T12:00:00Z',
};

const batch = [{
  date: '2026-04-18',
  runs: [{
    id: 101,
    name: 'CI',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-04-18T10:00:00Z',
    updated_at: '2026-04-18T10:10:00Z',
    html_url: 'https://example.com/runs/101',
    durationInSeconds: 600,
  }],
  attempts: [],
}];

function mockClient(failRunWrite = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id FROM repos')) return { rows: [{ id: 1 }] };
    if (failRunWrite && sql.includes('INSERT INTO runs')) throw new Error('run write failed');
    return { rows: [] };
  });
  return { query, release: vi.fn() };
}

describe('persistCollectionWindow', () => {
  it('commits raw runs and the checkpoint in one transaction', async () => {
    const client = mockClient();
    vi.mocked(getDatabaseClient).mockResolvedValue(client as never);

    await persistCollectionWindow('acme/widgets', batch, state);

    const queries = client.query.mock.calls.map(([sql]) => sql);
    expect(queries.indexOf('BEGIN')).toBeLessThan(queries.findIndex(sql => sql.includes('INSERT INTO runs')));
    expect(queries.findIndex(sql => sql.includes('INSERT INTO runs'))).toBeLessThan(
      queries.findIndex(sql => sql.includes('INSERT INTO collection_state')),
    );
    expect(queries.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back without checkpointing when a raw run write fails', async () => {
    const client = mockClient(true);
    vi.mocked(getDatabaseClient).mockResolvedValue(client as never);

    await expect(persistCollectionWindow('acme/widgets', batch, state)).rejects.toThrow('run write failed');

    const queries = client.query.mock.calls.map(([sql]) => sql);
    expect(queries).toContain('ROLLBACK');
    expect(queries.some(sql => sql.includes('INSERT INTO collection_state'))).toBe(false);
  });
});
