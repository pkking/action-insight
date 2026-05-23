import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../../supabase/schema.sql');

function isTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isProtectedRuntime() {
  return Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.VERCEL);
}

function isProductionDeployment() {
  return process.env.VERCEL_ENV === 'production';
}

function isMainBranchWorkflow() {
  return (
    process.env.GITHUB_REF === 'refs/heads/main' ||
    process.env.GITHUB_REF_NAME === 'main'
  );
}

function shouldRunMigration() {
  if (isTruthy(process.env.FORCE_SUPABASE_MIGRATION)) {
    return true;
  }

  if (!isProtectedRuntime()) {
    return true;
  }

  return isTruthy(process.env.AUTO_MIGRATE_SUPABASE) && (isProductionDeployment() || isMainBranchWorkflow());
}

function getConnectionString() {
  return (
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL
  );
}

function normalizeConnectionString(connectionString) {
  if (process.env.SUPABASE_DB_SSL !== 'no-verify') {
    return connectionString;
  }

  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.set('sslmode', 'no-verify');
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function main() {
  if (!shouldRunMigration()) {
    console.log('Skipping Supabase migration: protected runtime requires AUTO_MIGRATE_SUPABASE=1 on main/production.');
    return;
  }

  const connectionString = getConnectionString();

  if (!connectionString) {
    console.log('Skipping Supabase migration: no database connection URL is configured.');
    return;
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');
  const client = new pg.Client({
    connectionString: normalizeConnectionString(connectionString),
    ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : { rejectUnauthorized: process.env.SUPABASE_DB_SSL !== 'no-verify' },
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log(`Supabase migration applied from ${path.relative(process.cwd(), schemaPath)}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Supabase migration failed:', error);
  process.exit(1);
});
