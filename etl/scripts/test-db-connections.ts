/**
 * Quick connection test for Supabase → Turso migration.
 * Usage: npx tsx etl/scripts/test-db-connections.ts
 *
 * Supabase connection uses SOCKS5 proxy (127.0.0.1:10808) if available.
 */
import pg from 'pg';
import { createClient } from '@libsql/client';
import { SocksClient } from 'socks';
import { Duplex, PassThrough } from 'stream';
import * as tls from 'tls';

function normalizeConnectionString(connectionString: string): string {
  if (process.env.SUPABASE_DB_SSL !== 'no-verify') {
    return connectionString;
  }
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * Create a duplex stream through SOCKS5 proxy that pg can use.
 * pg expects the `stream` option to return a duplex stream synchronously,
 * but we need async proxy connection. Workaround: return a PassThrough
 * and pipe the real socket to it once connected.
 */
function createProxyStream(
  host: string,
  port: number,
  proxyHost: string,
  proxyPort: number,
): Duplex {
  // Create a PassThrough as the "synchronous" return value
  const passThrough = new PassThrough() as Duplex;

  // Connect through proxy in background
  SocksClient.createConnection({
    proxy: {
      host: proxyHost,
      port: proxyPort,
      type: 5,
    },
    command: 'connect',
    destination: { host, port },
  }).then(({ socket }) => {
    // Pipe socket to passThrough bidirectionally
    socket.pipe(passThrough);
    passThrough.pipe(socket);

    socket.on('error', (e) => passThrough.emit('error', e));
    passThrough.on('error', (e) => socket.destroy(e));

    socket.on('close', () => passThrough.emit('close'));
    passThrough.on('close', () => socket.destroy());

    // pg needs setNoDelay, setKeepAlive etc - delegate to socket
    (passThrough as any).setNoDelay = (noDelay: boolean) => socket.setNoDelay(noDelay);
    (passThrough as any).setKeepAlive = (enable: boolean, initialDelay?: number) =>
      socket.setKeepAlive(enable, initialDelay);
  }).catch((e) => {
    passThrough.emit('error', e);
  });

  return passThrough;
}

async function testSupabase(): Promise<void> {
  let url = process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;

  console.log('🔗 Testing Supabase (PostgreSQL)...');
  console.log('   URL:', url?.replace(/\/\/.*@/, '//***@'));

  const parsedUrl = new URL(url!);
  const dbHost = parsedUrl.hostname;
  const dbPort = parseInt(parsedUrl.port || '5432', 10);
  const proxyHost = '127.0.0.1';
  const proxyPort = 10808;

  console.log('   Target:', dbHost + ':' + dbPort);
  console.log('   Proxy: socks://' + proxyHost + ':' + proxyPort);

  // Normalize sslmode
  url = normalizeConnectionString(url!);

  const useProxy = process.env.USE_PG_PROXY !== '0';

  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : {
      rejectUnauthorized: process.env.SUPABASE_DB_SSL !== 'no-verify',
    },
    ...(useProxy ? {
      stream: () => createProxyStream(dbHost, dbPort, proxyHost, proxyPort),
    } : {}),
  });

  await client.connect();
  console.log('✅ Supabase connected!');

  const { rows: tables } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  );

  console.log('');
  console.log('📊 Tables found:');
  for (const t of tables) {
    const { rows } = await client.query('SELECT count(*) FROM ' + t.tablename);
    const size = await client.query(
      "SELECT pg_size_pretty(pg_total_relation_size('public.'" + t.tablename + "'))"
    );
    console.log(
      '   ' + t.tablename.padEnd(30) +
      String(rows[0].count).padStart(8) + ' rows  (' + size.rows[0].pg_size_pretty + ')'
    );
  }

  await client.end();
}

async function testTurso(): Promise<void> {
  console.log('');
  console.log('🔗 Testing Turso (libSQL)...');
  console.log('   URL:', process.env.TURSO_DATABASE_URL?.replace(/\/\/[^/]+/, '//***@'));

  const turso = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await turso.execute('SELECT 1');
  console.log('✅ Turso connected!');

  const { rows: tursoTables } = await turso.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  console.log('');
  console.log('📊 Tables found:');
  for (const row of tursoTables) {
    const name = row.name as string;
    const { rows } = await turso.execute('SELECT count(*) as c FROM ' + name);
    console.log('   ' + name.padEnd(30) + String(rows[0].c as number).padStart(8) + ' rows');
  }
}

async function main(): Promise<void> {
  try {
    await testSupabase();
  } catch (e) {
    console.error('❌ Supabase connection failed:', e);
  }

  try {
    await testTurso();
  } catch (e) {
    console.error('❌ Turso connection failed:', e);
  }
}

main();
