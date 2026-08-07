/**
 * One-time migration: Turso (libSQL) → PostgreSQL.
 *
 * Reads all tables from the source Turso database and writes them into the
 * local PostgreSQL instance. Uses keyset pagination (rowid or PK) instead of
 * OFFSET to avoid O(N²) slowdown on large tables.
 *
 * Prerequisites:
 *   - @libsql/client installed (npm install @libsql/client — temporary devDep)
 *   - Target PostgreSQL running and schema applied (docker compose up -d)
 *
 * Usage:
 *   npx tsx etl/scripts/migrate-turso-to-pg.ts
 *
 * Environment:
 *   TURSO_DATABASE_URL   Source Turso database URL (required)
 *   TURSO_AUTH_TOKEN     Source Turso auth token (required for remote)
 *   PG_DATABASE_URL      Target PostgreSQL connection string (required)
 */

import { createClient } from '@libsql/client';
import { Pool } from 'pg';

const BATCH_SIZE = Number(process.env.MIGRATION_BATCH_SIZE) || 2000;
const MAX_RETRIES = Number(process.env.MIGRATION_MAX_RETRIES) || 3;
const RETRY_DELAY = Number(process.env.MIGRATION_RETRY_DELAY) || 1000;

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
const pgUrl = process.env.PG_DATABASE_URL;

if (!tursoUrl) {
  console.error('Error: TURSO_DATABASE_URL is required (source database)');
  process.exit(1);
}
if (!pgUrl) {
  console.error('Error: PG_DATABASE_URL is required (target database)');
  process.exit(1);
}

const turso = createClient({ url: tursoUrl, authToken: tursoToken });
const pg = new Pool({ connectionString: pgUrl, max: 4 });

interface TableSpec {
  name: string;
  key: string;
  composite: boolean;
}

// Tables ordered to respect FK dependencies (parents first)
const tables: TableSpec[] = [
  { name: 'repos',                key: 'id',    composite: false },
  { name: 'runs',                 key: 'id',    composite: false },
  { name: 'jobs',                 key: 'id',    composite: false },
  { name: 'steps',                key: 'rowid',  composite: true  },
  { name: 'workflow_attempts',    key: 'rowid',  composite: true  },
  { name: 'workflow_jobs',        key: 'rowid',  composite: true  },
  { name: 'workflow_steps',       key: 'rowid',  composite: true  },
  { name: 'pr_metrics',           key: 'id',     composite: false },
  { name: 'pr_workflows',         key: 'id',     composite: false },
  { name: 'pr_workflow_attempts', key: 'rowid',  composite: true  },
  { name: 'pr_resolution_cache',  key: 'id',     composite: false },
  { name: 'collection_state',     key: 'id',     composite: false },
  { name: 'test_case_stats',     key: 'id',     composite: false },
];

const conflictMap: Record<string, string> = {
  repos: 'ON CONFLICT(owner, repo) DO NOTHING',
  collection_state: 'ON CONFLICT(repo_id) DO NOTHING',
  pr_metrics: 'ON CONFLICT(repo_id, pr_number) DO NOTHING',
  pr_resolution_cache: 'ON CONFLICT(repo_id, head_sha) DO NOTHING',
  pr_workflows: 'ON CONFLICT(pr_metric_id, run_id) DO NOTHING',
  pr_workflow_attempts: 'ON CONFLICT(pr_metric_id, run_id, run_attempt) DO NOTHING',
  test_case_stats: 'ON CONFLICT(repo_id, window_start, window_end) DO NOTHING',
  runs: 'ON CONFLICT(id) DO NOTHING',
  jobs: 'ON CONFLICT(id) DO NOTHING',
  steps: 'ON CONFLICT(job_id, number) DO NOTHING',
  workflow_attempts: 'ON CONFLICT(run_id, run_attempt) DO NOTHING',
  workflow_jobs: 'ON CONFLICT(run_id, run_attempt, job_id) DO NOTHING',
  workflow_steps: 'ON CONFLICT(run_id, run_attempt, job_id, step_number) DO NOTHING',
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrateTable(spec: TableSpec): Promise<void> {
  const { name, key, composite } = spec;

  // Check if PG already has full data for this table
  const { rows: pgCountRows } = await pg.query(`SELECT COUNT(*) as c FROM ${name}`);
  const pgCount = Number(pgCountRows[0].c);

  const { rows: tursoCountRows } = await turso.execute(`SELECT COUNT(*) as c FROM ${name}`);
  const tursoCount = Number(tursoCountRows[0].c);

  if (pgCount >= tursoCount && tursoCount > 0) {
    console.log(`${name}: ${pgCount}/${tursoCount} — already complete, skip`);
    return;
  }

  // Get column list from a sample row
  const selectCol = composite ? `${key}, *` : `*`;
  const sample = await turso.execute(`SELECT ${selectCol} FROM ${name} LIMIT 1`);
  if (sample.rows.length === 0) {
    console.log(`${name}: empty, skip`);
    return;
  }
  const allCols = Object.keys(sample.rows[0]);
  const insertCols = composite ? allCols.filter((c) => c !== key) : allCols;
  const colList = insertCols.join(',');
  const conflict = conflictMap[name] || '';

  // For tables with partial data and non-composite PK, resume from max key
  let lastKey: number = 0;
  if (pgCount > 0 && !composite) {
    const { rows: maxRows } = await pg.query(`SELECT COALESCE(MAX(${key}), 0) as m FROM ${name}`);
    lastKey = Number(maxRows[0].m);
    console.log(`${name}: resuming from ${key}=${lastKey} (${pgCount} already in PG)`);
  }

  // For composite-PK tables with partial data, use session_replication_role
  // to bypass FK constraints (Turso may have orphaned rows)
  const client = await pg.connect();
  if (composite && pgCount > 0) {
    await client.query('SET session_replication_role = replica');
  }

  try {
    let total = pgCount;
    let batch = 0;

    while (true) {
      const { rows } = await turso.execute({
        sql: `SELECT ${selectCol} FROM ${name} WHERE ${key} > ? ORDER BY ${key} LIMIT ${BATCH_SIZE}`,
        args: [lastKey],
      });
      if (rows.length === 0) break;

      const valueParts = rows.map((_, ri) => {
        const base = ri * insertCols.length;
        return `(${insertCols.map((_, ci) => `$${base + ci + 1}`).join(',')})`;
      }).join(',');
      const params = rows.flatMap((r) => insertCols.map((c) => {
        const v = r[c];
        if (v === undefined) return null;
        return v;
      }));
      const sql = `INSERT INTO ${name} (${colList}) VALUES ${valueParts} ${conflict}`.trim();

      let retry = 0;
      while (true) {
        try {
          const result = await client.query(sql, params);
          total += result.rowCount ?? 0;
          break;
        } catch (err) {
          retry++;
          if (retry > MAX_RETRIES) throw err;
          await sleep(RETRY_DELAY * retry);
        }
      }

      lastKey = Number(rows[rows.length - 1][key]);
      batch++;

      if (batch % 10 === 0 || rows.length < BATCH_SIZE) {
        process.stdout.write(`\r${name}: ${total}/${tursoCount} rows...`);
      }
    }

    if (composite && pgCount > 0) {
      await client.query('SET session_replication_role = default');
    }

    console.log(`\r${name}: ${total}/${tursoCount} rows done`);
  } catch (err) {
    if (composite && pgCount > 0) {
      await client.query('SET session_replication_role = default');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function fixSequences(): Promise<void> {
  console.log('\n=== Fixing sequences ===');
  for (const t of ['repos', 'pr_metrics', 'pr_workflows', 'pr_resolution_cache', 'collection_state', 'test_case_stats']) {
    try {
      await pg.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1) + 1, false)`);
      console.log(`  ${t}: sequence updated`);
    } catch (e) {
      console.log(`  ${t}: ${e instanceof Error ? e.message.slice(0, 60) : e}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('=== Turso → PostgreSQL Migration ===');
  console.log(`Source: Turso (${tursoUrl.replace(/\/\/.*@/, '//***@')})`);
  console.log(`Target: PostgreSQL (${pgUrl.replace(/\/\/.*@/, '//***@')})`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  const failed: string[] = [];

  for (const spec of tables) {
    try {
      await migrateTable(spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${spec.name}: ERROR - ${msg.slice(0, 120)}`);
      failed.push(spec.name);
    }
  }

  await fixSequences();

  console.log('\n=== Final PG counts ===');
  for (const { name } of tables) {
    const { rows } = await pg.query(`SELECT COUNT(*) as c FROM ${name}`);
    console.log(`  ${name}: ${rows[0].c}`);
  }

  if (failed.length > 0) {
    console.log(`\n${failed.length} table(s) failed: ${failed.join(', ')}`);
    process.exit(1);
  }

  console.log('\nMigration complete!');
  await pg.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
