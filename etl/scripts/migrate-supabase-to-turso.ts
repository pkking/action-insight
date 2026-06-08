/**
 * migrate-supabase-to-turso.ts
 *
 * Migrates all data from Supabase (PostgreSQL) to Turso (libSQL/SQLite).
 *
 * Usage:
 *   npx tsx etl/scripts/migrate-supabase-to-turso.ts
 *
 * Required env vars:
 *   SUPABASE_DB_URL    - PostgreSQL connection string for Supabase
 *   TURSO_DATABASE_URL - Turso database URL (libsql:// or libsqls://)
 *   TURSO_AUTH_TOKEN   - Turso auth token (if using remote database)
 *
 * The script:
 *   1. Reads all tables from Supabase in dependency order (repos → runs → jobs → steps → ...)
 *   2. Inserts rows into Turso preserving all primary key IDs so FK references remain valid
 *   3. Resets AUTOINCREMENT counters to continue correctly after migration
 *   4. Reports row counts and elapsed time
 *
 * Safety:
 *   - Upserts (ON CONFLICT DO NOTHING) so re-runs are safe
 *   - Processes tables in foreign-key-safe order
 *   - Does NOT drop or truncate any Turso tables
 */

import { createClient, type Client as TursoClient, type InValue } from '@libsql/client';
import pg from 'pg';
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE || '1000', 10);
const MAX_RETRIES = parseInt(process.env.MIGRATION_MAX_RETRIES || '5', 10);
const RETRY_DELAY_MS = parseInt(process.env.MIGRATION_RETRY_DELAY || '2000', 10);

const TABLES_TO_MIGRATE = [
  'repos',
  'runs',
  'jobs',
  'steps',
  'pr_metrics',
  'pr_workflows',
  'pr_resolution_cache',
  'collection_state',
  'test_case_stats',
] as const;

// Columns to SELECT from PostgreSQL. TIMESTAMPTZ/DATE columns are cast to TEXT
// so they remain valid ISO strings in Turso's TEXT columns.
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
  pr_workflows: ['id', 'pr_metric_id', 'run_id'],
  pr_resolution_cache: [
    'id', 'repo_id', 'head_sha', 'pr_number', 'source', 'status',
    'error_message', 'attempted_at', 'resolved_at',
  ],
  collection_state: [
    'id', 'repo_id', 'backfill_cursor', 'history_complete',
    'latest_date', 'retention_days', 'last_updated',
  ],
  test_case_stats: [
    'id', 'repo_id', 'window_start', 'window_end', 'total_test_cases',
    'ascend_test_cases', 'nvidia_test_cases', 'generated_at',
  ],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function* chunkArray<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return m > 0 ? `${m}m${remS}s` : `${s}s`;
}

/**
 * Wait for a local TCP port to be listening.
 */
async function waitForPort(host: string, port: number, timeoutMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(1000);
      const cleanup = () => { socket.destroy(); socket.removeAllListeners(); };
      socket.on('connect', () => { cleanup(); resolve(true); });
      socket.on('error', () => { cleanup(); resolve(false); });
      socket.on('timeout', () => { cleanup(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

/**
 * Spawn a SOCKS5 tunnel subprocess and return the local port it listens on.
 * The tunnel forwards local TCP connections through a SOCKS5 proxy.
 */
async function startSocksTunnel(
  remoteHost: string,
  remotePort: number,
  proxyHost: string = '127.0.0.1',
  proxyPort: number = 10808,
  localPort: number = 5433,
): Promise<ChildProcess> {
  // Use the socks-tunnel.ts script as a subprocess
  const tunnelScript = path.join(__dirname, 'socks-tunnel.ts');

  const child = spawn('npx', ['tsx', tunnelScript], {
    env: {
      ...process.env,
      TUNNEL_LOCAL_PORT: String(localPort),
      TUNNEL_REMOTE_HOST: remoteHost,
      TUNNEL_REMOTE_PORT: String(remotePort),
      TUNNEL_PROXY_HOST: proxyHost,
      TUNNEL_PROXY_PORT: String(proxyPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`   [tunnel] ${msg}`);
  });
  child.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`   [tunnel] ${msg}`);
  });

  // Wait for tunnel to be ready
  await waitForPort('127.0.0.1', localPort);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`   ⚠️  Tunnel process exited with code ${code}`);
    }
  });

  return child;
}

/**
 * Rewrite a PostgreSQL connection URL to point to a different host:port.
 * Preserves auth credentials, database name, and other query params.
 */
function rewritePgUrl(originalUrl: string, host: string, port: number): string {
  const parsed = new URL(originalUrl);
  parsed.hostname = host;
  parsed.port = String(port);
  return parsed.toString();
}

/**
 * Convert a PostgreSQL row to values suitable for Turso INSERT.
 *
 * - BOOLEAN columns (partial_ci_history, history_complete) are converted to 0/1.
 * - All TIMESTAMPTZ/DATE values from pg are already Date objects; we convert
 *   them to ISO strings to match Turso's TEXT columns.
 */
function pgRowToTursoValues(
  row: Record<string, unknown>,
  columns: string[],
): InValue[] {
  const values: InValue[] = [];

  const booleanColumns = new Set([
    'partial_ci_history',
    'history_complete',
  ]);

  const dateColumns = new Set([
    'created_at', 'updated_at', 'started_at', 'completed_at',
    'date', 'steps_checked_at', 'ci_started_at', 'ci_completed_at',
    'merged_at', 'attempted_at', 'resolved_at', 'last_updated',
    'backfill_cursor', 'latest_date', 'window_start', 'window_end',
    'generated_at',
  ]);

  for (const col of columns) {
    const raw = row[col];

    if (raw === null || raw === undefined) {
      values.push(null);
    } else if (booleanColumns.has(col)) {
      values.push(raw === true ? 1 : 0);
    } else if (dateColumns.has(col) && raw instanceof Date) {
      values.push(raw.toISOString());
    } else if (typeof raw === 'bigint') {
      // Turso supports 64-bit signed integers, but we convert to number
      // for safety (GitHub IDs fit in 53-bit).
      const num = Number(raw);
      if (!Number.isSafeInteger(num)) {
        console.warn(`⚠️  BigInt overflow risk: ${col}=${raw}`);
      }
      values.push(num);
    } else {
      values.push(raw as InValue);
    }
  }

  return values;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const startMs = Date.now();

  // --- Validate env ---
  const supabaseUrl =
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!supabaseUrl) {
    console.error('❌ SUPABASE_DB_URL is not set');
    process.exit(1);
  }

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (!tursoUrl) {
    console.error('❌ TURSO_DATABASE_URL is not set');
    process.exit(1);
  }

  const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;

  console.log('📦 Action Insight: Supabase → Turso Migration');
  console.log(`   Source:  Supabase (PostgreSQL)`);
  console.log(`   Target:  Turso (libSQL/SQLite)`);

  // --- Proxy setup ---
  const useProxy = process.env.USE_PG_PROXY !== '0';
  let proxyHost = '127.0.0.1';
  let proxyPort = 10808;
  const TUNNEL_PORT = parseInt(process.env.TUNNEL_LOCAL_PORT || '5433', 10);
  let tunnelProcess: ChildProcess | null = null;
  let effectiveUrl = supabaseUrl;

  if (useProxy) {
    const proxyUrl = process.env.PG_PROXY_URL || process.env.SOCKS_PROXY || '';
    if (proxyUrl) {
      try {
        const parsed = new URL(proxyUrl);
        proxyHost = parsed.hostname;
        proxyPort = parseInt(parsed.port, 10);
      } catch {
        console.log(`   ⚠️  Invalid proxy URL: ${proxyUrl}, using default socks://127.0.0.1:10808`);
      }
    }
    console.log(`   Proxy:   socks://${proxyHost}:${proxyPort}`);
  } else {
    console.log('   Proxy:   disabled (direct connection)');
  }

  // Parse original Supabase URL for remote host/port
  let supabaseHost = '';
  let supabasePort = 5432;
  try {
    const parsedUrl = new URL(supabaseUrl.split('?')[0]);
    supabaseHost = parsedUrl.hostname;
    supabasePort = parseInt(parsedUrl.port || '5432', 10);
  } catch {
    // fallback
  }

  if (useProxy) {
    // Start SOCKS5 tunnel subprocess
    console.log(`   Tunnel:  127.0.0.1:${TUNNEL_PORT} → ${supabaseHost}:${supabasePort}`);
    console.log('   Starting tunnel...');
    tunnelProcess = await startSocksTunnel(supabaseHost, supabasePort, proxyHost, proxyPort, TUNNEL_PORT);
    console.log('   ✅ Tunnel ready');

    // Rewrite connection URL to point to local tunnel
    effectiveUrl = rewritePgUrl(supabaseUrl, '127.0.0.1', TUNNEL_PORT);
    // Remove sslmode from URL - new pg treats 'require' as 'verify-full'
    try {
      const parsed = new URL(effectiveUrl);
      parsed.searchParams.delete('sslmode');
      effectiveUrl = parsed.toString();
    } catch { /* ignore */ }
    console.log(`   URL:     ${effectiveUrl.replace(/\/\/.*@/, '//***@')}`);
  }
  console.log('');

  // Cleanup handler
  const cleanup = () => {
    if (tunnelProcess && !tunnelProcess.killed) {
      tunnelProcess.kill();
    }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('exit', cleanup);

  // --- Connect to Supabase ---
  const pgClient = new pg.Client({
    connectionString: effectiveUrl,
    ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : {
      rejectUnauthorized: process.env.SUPABASE_DB_SSL !== 'no-verify',
      ...(useProxy && supabaseHost ? { servername: supabaseHost } : {}),
    },
  });

  await pgClient.connect();
  console.log('✅ Connected to Supabase (PostgreSQL)');

  const tursoClient: TursoClient = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken,
  });

  // Turso also needs proxy - use HTTPS_PROXY from env if set
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (httpsProxy) {
    console.log(`   Turso:   using HTTPS_PROXY=${httpsProxy}`);
  }

  // Test Turso connection
  await tursoClient.execute('SELECT 1');
  console.log('✅ Connected to Turso (libSQL)');

  // Disable foreign key checks during migration to handle dangling references
  // (e.g., jobs referencing deleted runs in Supabase)
  await tursoClient.execute('PRAGMA foreign_keys = OFF');
  console.log('   ⚠️  Foreign key checks disabled during migration');
  console.log('');

  // --- Migrate each table ---
  const summary: Array<{ table: string; count: number; duration: number }> = [];

  for (const tableName of TABLES_TO_MIGRATE) {
    const tableStart = Date.now();
    const columns = TABLE_COLUMNS[tableName];
    const idCol = columns[0]; // Primary key column
    const colList = columns.map((c) => `"${c}"`).join(', ');

    // Get total count first
    const { rows: countRows } = await pgClient.query(
      `SELECT count(*) FROM "${tableName}"`,
    );
    const totalCount = parseInt(countRows[0].count, 10);

    if (totalCount === 0) {
      console.log(`⏭️  ${tableName}: 0 rows, skipped`);
      continue;
    }

    console.log(`📋 ${tableName}: ${totalCount} rows to migrate...`);

    // Build INSERT statement
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    let migratedCount = 0;
    let batchNum = 0;
    let lastCursorValue: { job_id?: number; number?: number } | string | number | null = null;

    // Paginated fetch + write loop using keyset pagination (WHERE id > cursor)
    // This avoids PostgreSQL OFFSET slowness on large tables
    while (true) {
      let sql: string;
      let params: (string | number)[];

      // Special case: steps table has composite PK (job_id, number), not a single id column
      if (tableName === 'steps') {
        if (batchNum === 0 || lastCursorValue === null || typeof lastCursorValue === 'string' || typeof lastCursorValue === 'number') {
          sql = `SELECT ${colList} FROM "${tableName}" ORDER BY job_id, number LIMIT $1`;
          params = [BATCH_SIZE];
        } else {
          sql = `SELECT ${colList} FROM "${tableName}" WHERE (job_id, number) > ($1, $2) ORDER BY job_id, number LIMIT $3`;
          params = [lastCursorValue.job_id!, lastCursorValue.number!, BATCH_SIZE];
        }
      } else {
        if (batchNum === 0 || lastCursorValue === null || typeof lastCursorValue === 'object') {
          sql = `SELECT ${colList} FROM "${tableName}" ORDER BY ${idCol} LIMIT $1`;
          params = [BATCH_SIZE];
        } else {
          sql = `SELECT ${colList} FROM "${tableName}" WHERE "${idCol}" > $1 ORDER BY ${idCol} LIMIT $2`;
          params = [lastCursorValue, BATCH_SIZE];
        }
      }

      const { rows: pgRows } = await pgClient.query(sql, params);

      if (pgRows.length === 0) break;

      // Update cursor
      if (tableName === 'steps') {
        const lastRow = pgRows[pgRows.length - 1];
        lastCursorValue = { job_id: lastRow.job_id as number, number: lastRow.number as number };
      } else {
        lastCursorValue = pgRows[pgRows.length - 1][idCol] as string | number;
      }

      const stmts = pgRows.map((row) => ({
        sql: insertSql,
        args: pgRowToTursoValues(row, columns),
      }));

      // Retry loop for transient errors (404, network issues)
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`   ⏳ Retry ${attempt}/${MAX_RETRIES} for ${tableName} batch #${batchNum} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }

        const tx = await tursoClient.transaction('write');
        try {
          await tx.batch(stmts, 'write');
          await tx.commit();
          migratedCount += pgRows.length;
          lastError = null;
          break; // Success
        } catch (e: unknown) {
          try {
            await tx.rollback();
          } catch { /* ignore rollback error to preserve original error */ }
          lastError = e as Error;

          // Don't retry constraint violations or data errors
          const msg = (e as Error).message || '';
          if (msg.includes('UNIQUE') || msg.includes('FOREIGN KEY') || msg.includes('CHECK')) {
            console.error(`❌ Non-retryable error at ${tableName} batch #${batchNum}:`, e);
            throw e;
          }
        } finally {
          tx.close();
        }
      }

      if (lastError) {
        console.error(`❌ Failed after ${MAX_RETRIES} retries at ${tableName} batch #${batchNum}:`, lastError);
        throw lastError;
      }

      if (pgRows.length < BATCH_SIZE) break; // Last batch
      batchNum++;

      // Progress: show every 5000 rows or on last batch
      if (migratedCount % 5000 < BATCH_SIZE) {
        const pct = totalCount > 0 ? Math.round((migratedCount / totalCount) * 100) : 0;
        const elapsed = Date.now() - tableStart;
        const rate = migratedCount > 0 ? Math.round(migratedCount / (elapsed / 1000)) : 0;
        const eta = rate > 0 && totalCount > 0 ? Math.round((totalCount - migratedCount) / rate) : 0;
        console.log(`   📦 ${tableName}: ${migratedCount}/${totalCount} (${pct}%) ${rate} rows/s, ETA: ${formatDuration(eta * 1000)}`);
      }
    }

    const duration = Date.now() - tableStart;
    summary.push({ table: tableName, count: migratedCount, duration });
    console.log(`   ✅ ${tableName}: ${migratedCount} rows inserted (${formatDuration(duration)})`);
  }

  // --- Reset AUTOINCREMENT counters ---
  // For tables with AUTOINCREMENT, we need to update sqlite_sequence so new
  // inserts get IDs greater than the migrated data.
  console.log('');
  console.log('🔧 Resetting AUTOINCREMENT counters...');

  const autoincrementTables = [
    'repos', 'pr_metrics', 'pr_workflows',
    'pr_resolution_cache', 'collection_state', 'test_case_stats',
  ];

  for (const tableName of autoincrementTables) {
    const columns = TABLE_COLUMNS[tableName];
    const idCol = columns[0]; // First column is always the PK

    const { rows } = await tursoClient.execute(
      `SELECT MAX(${idCol}) as max_id FROM ${tableName}`,
    );

    const maxId = rows[0]?.max_id != null ? Number(rows[0].max_id) : 0;

    if (maxId > 0) {
      // Use INSERT OR REPLACE for sqlite_sequence (more compatible than ON CONFLICT)
      await tursoClient.execute({
        sql: `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
        args: [tableName, maxId],
      });
      console.log(`   ${tableName}: max_id=${maxId}`);
    }
  }

  // --- Disconnect ---
  await pgClient.end();
  cleanup(); // Kill tunnel subprocess

  // Re-enable foreign key checks
  await tursoClient.execute('PRAGMA foreign_keys = ON');
  console.log('   ✅ Foreign key checks re-enabled');
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
}

main().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
