/**
 * migrate-turso-to-sqlite.ts
 *
 * Migrates all data from Turso (remote libSQL) to local SQLite.
 *
 * Usage:
 *   npx tsx etl/scripts/migrate-turso-to-sqlite.ts
 *
 * Required env vars:
 *   TURSO_DATABASE_URL - Turso database URL (libsql:// or libsqls://)
 *   TURSO_AUTH_TOKEN   - Turso auth token
 *
 * Optional:
 *   SQLITE_DATABASE_URL  - Override local SQLite URL (default: file:etl/data/action-insight.db)
 *   SQLITE_PROJECT_NAME  - Project name for auto-derived filename (default: action-insight)
 *   MIGRATION_BATCH_SIZE - Rows per batch (default: 1000)
 *
 * The script:
 *   1. Reads all tables from Turso in dependency order
 *   2. Inserts rows into local SQLite preserving primary keys
 *   3. Reports row counts and elapsed time
 *
 * Safety:
 *   - Upserts (ON CONFLICT DO NOTHING) so re-runs are safe
 *   - Processes tables in foreign-key-safe order
 *   - Does NOT drop or truncate any existing SQLite tables
 */

import { createClient, type Client, type InValue } from '@libsql/client';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE || '1000', 10);

const TABLES_TO_MIGRATE = [
  'repos',
  'runs',
  'jobs',
  'steps',
  'pr_metrics',
  'pr_workflows',
  'pr_resolution_cache',
  'collection_state',
] as const;

const TABLE_COLUMNS: Record<string, string[]> = {
  repos: ['id', 'owner', 'repo'],
  runs: [
    'id', 'repo_id', 'name', 'head_branch', 'head_sha', 'status',
    'conclusion', 'event', 'created_at', 'updated_at', 'html_url',
    'duration_seconds', 'date', 'steps_checked_at',
  ],
  jobs: [
    'id', 'run_id', 'name', 'status', 'conclusion', 'created_at',
    'started_at', 'completed_at', 'html_url', 'queue_duration_seconds',
    'duration_seconds',
  ],
  steps: [
    'job_id', 'number', 'name', 'status', 'conclusion',
    'started_at', 'completed_at', 'duration_seconds',
  ],
  pr_metrics: [
    'id', 'repo_id', 'pr_number', 'title', 'branch', 'author', 'state',
    'html_url', 'created_at', 'ci_started_at', 'ci_completed_at',
    'merged_at', 'partial_ci_history', 'time_to_ci_start_seconds',
    'ci_duration_seconds', 'time_to_merge_seconds', 'merge_lead_time_seconds',
    'workflow_count', 'successful_workflow_count', 'conclusion',
  ],
  pr_workflows: ['pr_metric_id', 'run_id'],
  pr_resolution_cache: [
    'id', 'repo_id', 'head_sha', 'pr_number', 'source', 'status',
    'error_message', 'attempted_at', 'resolved_at',
  ],
  collection_state: [
    'repo_id', 'backfill_cursor', 'history_complete',
    'latest_date', 'retention_days', 'last_updated',
  ],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return m > 0 ? `${m}m${remS}s` : `${s}s`;
}

/** Resolve local SQLite URL (same logic as sqlite-storage.ts). */
function resolveSqliteUrl(): string {
  if (process.env.SQLITE_DATABASE_URL) return process.env.SQLITE_DATABASE_URL;
  if (process.env.SQLITE_DATABASE_FILE) return `file:${process.env.SQLITE_DATABASE_FILE}`;

  const scriptsDir = __dirname;
  const etlDir = path.dirname(scriptsDir);
  const dataDir = path.join(etlDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const projectName = process.env.SQLITE_PROJECT_NAME ?? 'action-insight';
  return `file:${path.join(dataDir, `${projectName}.db`)}`;
}

/* ------------------------------------------------------------------ */
/*  SQLite schema (identical to sqlite-storage.ts)                     */
/* ------------------------------------------------------------------ */

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id   INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  repo  TEXT NOT NULL,
  UNIQUE(owner, repo)
);

CREATE TABLE IF NOT EXISTS runs (
  id                 INTEGER PRIMARY KEY,
  repo_id            INTEGER NOT NULL,
  name               TEXT,
  head_branch        TEXT,
  head_sha           TEXT,
  status             TEXT,
  conclusion         TEXT,
  event              TEXT,
  created_at         TEXT,
  updated_at         TEXT,
  html_url           TEXT,
  duration_seconds   REAL,
  date               TEXT,
  steps_checked_at   TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id                      INTEGER PRIMARY KEY,
  run_id                  INTEGER NOT NULL,
  name                    TEXT,
  status                  TEXT,
  conclusion              TEXT,
  created_at              TEXT,
  started_at              TEXT,
  completed_at            TEXT,
  html_url                TEXT,
  queue_duration_seconds  REAL,
  duration_seconds        REAL
);

CREATE TABLE IF NOT EXISTS steps (
  job_id            INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  name              TEXT,
  status            TEXT,
  conclusion        TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  duration_seconds  REAL,
  PRIMARY KEY (job_id, number)
);

CREATE TABLE IF NOT EXISTS pr_metrics (
  id                          INTEGER PRIMARY KEY,
  repo_id                     INTEGER NOT NULL,
  pr_number                   INTEGER NOT NULL,
  title                       TEXT,
  branch                      TEXT,
  author                      TEXT,
  state                       TEXT,
  html_url                    TEXT,
  created_at                  TEXT,
  ci_started_at               TEXT,
  ci_completed_at             TEXT,
  merged_at                   TEXT,
  partial_ci_history          INTEGER DEFAULT 0,
  time_to_ci_start_seconds    REAL,
  ci_duration_seconds         REAL,
  time_to_merge_seconds       REAL,
  merge_lead_time_seconds     REAL,
  workflow_count              INTEGER,
  successful_workflow_count   INTEGER,
  conclusion                  TEXT,
  UNIQUE(repo_id, pr_number)
);

CREATE TABLE IF NOT EXISTS pr_workflows (
  pr_metric_id INTEGER NOT NULL,
  run_id       INTEGER NOT NULL,
  PRIMARY KEY (pr_metric_id, run_id)
);

CREATE TABLE IF NOT EXISTS pr_resolution_cache (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL,
  head_sha      TEXT NOT NULL,
  pr_number     INTEGER,
  source        TEXT,
  status        TEXT,
  error_message TEXT,
  attempted_at  TEXT,
  resolved_at   TEXT,
  UNIQUE(repo_id, head_sha)
);

CREATE TABLE IF NOT EXISTS collection_state (
  repo_id           INTEGER PRIMARY KEY,
  backfill_cursor   TEXT,
  history_complete  INTEGER DEFAULT 0,
  latest_date       TEXT,
  retention_days    INTEGER DEFAULT 90,
  last_updated      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date);
CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date);
CREATE INDEX IF NOT EXISTS idx_runs_event ON runs(event);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo ON pr_metrics(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo_ci ON pr_metrics(repo_id, ci_completed_at);
CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_repo_sha ON pr_resolution_cache(repo_id, head_sha);
`;

async function ensureSqliteSchema(client: Client): Promise<void> {
  const statements = SQLITE_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const sql of statements) {
    await client.execute({ sql, args: [] });
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const startMs = Date.now();

  // --- Validate env ---
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (!tursoUrl) {
    console.error('❌ TURSO_DATABASE_URL is not set');
    process.exit(1);
  }

  const sqliteUrl = resolveSqliteUrl();

  console.log('📦 Action Insight: Turso → SQLite Migration');
  console.log(`   Source:  Turso (remote libSQL)`);
  console.log(`   Target:  SQLite (local: ${sqliteUrl})`);

  // --- Proxy setup for Turso ---
  // @libsql/client uses Node's native fetch (undici) which doesn't respect https_proxy.
  // Set a global ProxyAgent dispatcher so all fetch calls go through the proxy.
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  if (proxyUrl) {
    // Convert http:// to socks:// for undici's ProxyAgent which understands both.
    const dispatcherUrl = proxyUrl.replace(/^http:/, 'socks:');
    console.log(`   Proxy:   ${dispatcherUrl}`);
    setGlobalDispatcher(new ProxyAgent(dispatcherUrl));
  } else {
    console.log('   Proxy:   none (direct connection)');
  }
  console.log('');

  // --- Connect to both databases ---
  const tursoClient = createClient({
    url: tursoUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await tursoClient.execute('SELECT 1');
  console.log('✅ Connected to Turso');

  const sqliteClient = createClient({ url: sqliteUrl });
  await ensureSqliteSchema(sqliteClient);
  console.log('✅ SQLite schema ready');

  // Disable FK checks during migration
  await sqliteClient.execute('PRAGMA foreign_keys = OFF');
  console.log('');

  // --- Migrate each table ---
  const summary: Array<{ table: string; count: number; duration: number }> = [];

  for (const tableName of TABLES_TO_MIGRATE) {
    const tableStart = Date.now();
    const columns = TABLE_COLUMNS[tableName];
    const isCompositePk = tableName === 'steps';
    const isPkAuto = tableName !== 'steps' && tableName !== 'pr_workflows' && tableName !== 'collection_state';

    // Get total count
    const { rows: countRows } = await tursoClient.execute(
      `SELECT count(*) as cnt FROM ${tableName}`,
    );
    const totalCount = Number(countRows[0].cnt);

    if (totalCount === 0) {
      console.log(`⏭️  ${tableName}: 0 rows, skipped`);
      continue;
    }

    console.log(`📋 ${tableName}: ${totalCount} rows to migrate...`);

    // Build INSERT with ON CONFLICT DO NOTHING
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    let migratedCount = 0;
    let offset = 0;
    const idCol = columns[0];

    while (true) {
      let fetchSql: string;
      let fetchArgs: InValue[];

      if (isCompositePk) {
        fetchSql = `SELECT ${columns.join(', ')} FROM ${tableName} ORDER BY job_id, number LIMIT ? OFFSET ?`;
        fetchArgs = [BATCH_SIZE, offset];
      } else {
        fetchSql = `SELECT ${columns.join(', ')} FROM ${tableName} ORDER BY ${idCol} LIMIT ? OFFSET ?`;
        fetchArgs = [BATCH_SIZE, offset];
      }

      const { rows } = await tursoClient.execute({ sql: fetchSql, args: fetchArgs });

      if (rows.length === 0) break;

      const stmts = rows.map((row) => ({
        sql: insertSql,
        args: columns.map((col) => {
          const val = row[col];
          // Convert boolean-like integers for SQLite compatibility
          if (col === 'partial_ci_history' || col === 'history_complete') {
            return val === true || val === 1 ? 1 : 0;
          }
          // Convert Date objects to ISO strings
          if (val instanceof Date) return val.toISOString();
          return val ?? null;
        }) as InValue[],
      }));

      const tx = await sqliteClient.transaction('write');
      try {
        await tx.batch(stmts);
        await tx.commit();
        migratedCount += rows.length;
      } catch (e) {
        await tx.rollback();
        throw e;
      } finally {
        tx.close();
      }

      offset += BATCH_SIZE;
      if (rows.length < BATCH_SIZE) break;

      // Progress
      if (migratedCount % 5000 < BATCH_SIZE) {
        const pct = Math.round((migratedCount / totalCount) * 100);
        const elapsed = Date.now() - tableStart;
        const rate = migratedCount > 0 ? Math.round(migratedCount / (elapsed / 1000)) : 0;
        console.log(`   📦 ${tableName}: ${migratedCount}/${totalCount} (${pct}%) ${rate} rows/s`);
      }
    }

    const duration = Date.now() - tableStart;
    summary.push({ table: tableName, count: migratedCount, duration });
    console.log(`   ✅ ${tableName}: ${migratedCount} rows inserted (${formatDuration(duration)})`);
  }

  // --- Re-enable FK checks ---
  await sqliteClient.execute('PRAGMA foreign_keys = ON');
  console.log('   ✅ Foreign key checks re-enabled');

  // --- Summary ---
  console.log('');
  console.log('📊 Migration Summary');
  console.log('─'.repeat(50));

  let totalRows = 0;
  for (const { table, count, duration } of summary) {
    console.log(`   ${table.padEnd(30)} ${String(count).padStart(8)} rows  (${formatDuration(duration)})`);
    totalRows += count;
  }

  const totalMs = Date.now() - startMs;
  console.log('─'.repeat(50));
  console.log(`   Total: ${totalRows} rows in ${formatDuration(totalMs)}`);
  console.log('');
  console.log('✅ Migration complete!');
  console.log(`   Database saved to: ${sqliteUrl.replace('file:', '')}`);
}

main().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
