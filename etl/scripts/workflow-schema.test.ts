import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initSqlite, SQLITE_SCHEMA } from './sqlite-storage';

/**
 * Apply the real SQLite schema to an in-memory database and return the client.
 * This exercises the actual production schema, so drift is caught here.
 */
async function schemaClient() {
  const client = createClient({ url: ':memory:' });
  for (const stmt of SQLITE_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await client.execute({ sql: stmt, args: [] });
  }
  return client;
}

async function seedRun(client: Awaited<ReturnType<typeof schemaClient>>, runId: number) {
  await client.execute({
    sql: `INSERT INTO repos (id, owner, repo) VALUES (1, 'acme', 'widgets') ON CONFLICT DO NOTHING`,
    args: [],
  });
  await client.execute({
    sql: `INSERT INTO runs (id, repo_id, name, head_branch, status, conclusion, created_at, updated_at, html_url, duration_seconds, date)
          VALUES (?, 1, 'CI', 'main', 'completed', 'success', '2026-07-03T00:00:00Z', '2026-07-03T00:10:00Z', 'https://example.com', 600, '2026-07-03')
          ON CONFLICT DO NOTHING`,
    args: [runId],
  });
}

describe('ADR-005 attempt-scoped schema identity', () => {
  it('applies the additive schema without breaking the existing tables', async () => {
    const client = await schemaClient();
    // Existing tables are readable.
    const runs = await client.execute({ sql: 'SELECT * FROM runs LIMIT 1', args: [] });
    expect(runs.rows).toHaveLength(0);
    // New columns exist on runs.
    const cols = await client.execute({
      sql: "SELECT name FROM pragma_table_info('runs') ORDER BY cid",
      args: [],
    });
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain('workflow_file');
    expect(names).toContain('workflow_ref');
    expect(names).toContain('workflow_path');
    expect(names).toContain('workflow_parse_status');
    await client.close();
  });

  it('keeps multiple attempts for the same run as separate rows', async () => {
    const client = await schemaClient();
    await seedRun(client, 100);
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked, workflow_file) VALUES (?, ?, ?, ?, ?)`,
      args: [100, 1, 'completed', 1, 'ci.yml'],
    });
    // A rerun (attempt 2) for the same run must not overwrite attempt 1.
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked, workflow_file) VALUES (?, ?, ?, ?, ?)`,
      args: [100, 2, 'completed', 1, 'ci.yml'],
    });
    const rows = await client.execute({ sql: 'SELECT run_attempt FROM workflow_attempts WHERE run_id=100 ORDER BY run_attempt', args: [] });
    expect(rows.rows.map((r) => r.run_attempt)).toEqual([1, 2]);
    await client.close();
  });

  it('rejects a duplicate attempt for the same run_id + run_attempt', async () => {
    const client = await schemaClient();
    await seedRun(client, 200);
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status) VALUES (?, ?, ?)`,
      args: [200, 1, 'completed'],
    });
    await expect(
      client.execute({
        sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status) VALUES (?, ?, ?)`,
        args: [200, 1, 'in_progress'],
      }),
    ).rejects.toThrow();
    await client.close();
  });

  it('keys attempt-scoped jobs and steps by run_id + run_attempt + job_id(+step)', async () => {
    const client = await schemaClient();
    await seedRun(client, 300);
    // Seed a tracked attempt.
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked) VALUES (?, ?, ?, ?)`,
      args: [300, 1, 'completed', 1],
    });
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked) VALUES (?, ?, ?, ?)`,
      args: [300, 2, 'completed', 1],
    });
    // Same job_id across two attempts stays distinct.
    await client.execute({
      sql: `INSERT INTO workflow_jobs (run_id, run_attempt, job_id, name, status) VALUES (?, ?, ?, ?, ?)`,
      args: [300, 1, 9, 'build', 'success'],
    });
    await client.execute({
      sql: `INSERT INTO workflow_jobs (run_id, run_attempt, job_id, name, status) VALUES (?, ?, ?, ?, ?)`,
      args: [300, 2, 9, 'build', 'failure'],
    });
    const jobs = await client.execute({ sql: 'SELECT run_attempt, status FROM workflow_jobs WHERE run_id=300 AND job_id=9 ORDER BY run_attempt', args: [] });
    expect(jobs.rows.map((r) => [r.run_attempt, r.status])).toEqual([
      [1, 'success'],
      [2, 'failure'],
    ]);

    // Steps keyed by full step attempt identity.
    await client.execute({
      sql: `INSERT INTO workflow_steps (run_id, run_attempt, job_id, step_number, name, status) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [300, 1, 9, 1, 'checkout', 'success'],
    });
    await expect(
      client.execute({
        sql: `INSERT INTO workflow_steps (run_id, run_attempt, job_id, step_number, name, status) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [300, 1, 9, 1, 'checkout', 'success'],
      }),
    ).rejects.toThrow();
    await client.close();
  });

  it('links PR metrics to workflow attempts without collapsing reruns', async () => {
    const client = await schemaClient();
    await seedRun(client, 500);
    await client.execute({
      sql: `INSERT INTO pr_metrics (id, repo_id, pr_number, title, branch, state, html_url, created_at) VALUES (1, 1, 5, 't', 'main', 'open', 'https://example.com', '2026-07-03')`,
      args: [],
    });
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked) VALUES (500, 1, 'completed', 1)`,
      args: [],
    });
    await client.execute({
      sql: `INSERT INTO workflow_attempts (run_id, run_attempt, status, tracked) VALUES (500, 2, 'completed', 1)`,
      args: [],
    });
    // Both attempts link to the same PR metric.
    await client.execute({ sql: `INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt) VALUES (1, 500, 1)`, args: [] });
    await client.execute({ sql: `INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt) VALUES (1, 500, 2)`, args: [] });
    const links = await client.execute({ sql: 'SELECT run_attempt FROM pr_workflow_attempts WHERE pr_metric_id=1 ORDER BY run_attempt', args: [] });
    expect(links.rows.map((r) => r.run_attempt)).toEqual([1, 2]);
    await client.close();
  });

  it('enforces attempt-scoped foreign keys for jobs and PR links', async () => {
    const client = await schemaClient();
    await seedRun(client, 700);
    await expect(
      client.execute({
        sql: `INSERT INTO workflow_jobs (run_id, run_attempt, job_id, name, status) VALUES (?, ?, ?, ?, ?)`,
        args: [700, 2, 1, 'build', 'completed'],
      })
    ).rejects.toThrow();
    await expect(
      client.execute({
        sql: `INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt) VALUES (?, ?, ?)`,
        args: [1, 700, 2],
      })
    ).rejects.toThrow();
    await client.close();
  });

  it('upgrades an existing runs table with workflow metadata columns', async () => {
    const previousDir = process.env.SQLITE_DATA_DIR;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-insight-schema-'));
    process.env.SQLITE_DATA_DIR = tempDir;
    const dbPath = path.join(tempDir, 'acme-widgets.db');
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute({
      sql: `CREATE TABLE runs (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, name TEXT, head_branch TEXT,
        head_sha TEXT, status TEXT, conclusion TEXT, event TEXT, created_at TEXT,
        updated_at TEXT, html_url TEXT, duration_seconds REAL, date TEXT,
        steps_checked_at TEXT
      )`,
      args: [],
    });
    await client.close();

    try {
      await initSqlite('acme/widgets');
      const upgraded = createClient({ url: `file:${dbPath}` });
      const cols = await upgraded.execute({ sql: "SELECT name FROM pragma_table_info('runs')", args: [] });
      expect(cols.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
        'workflow_file',
        'workflow_ref',
        'workflow_path',
        'workflow_parse_status',
      ]));
      await upgraded.execute({
        sql: `SELECT * FROM runs INDEXED BY idx_runs_workflow_file WHERE repo_id = 1 AND workflow_file IS NULL`,
        args: [],
      });
      await upgraded.close();
    } finally {
      if (previousDir === undefined) delete process.env.SQLITE_DATA_DIR;
      else process.env.SQLITE_DATA_DIR = previousDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
