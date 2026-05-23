import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../../supabase/schema.sql');

function isTruthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
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
  if (process.env.SUPABASE_DB_SSL === 'verify-full') {
    return connectionString;
  }

  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  url.searchParams.set('sslmode', 'no-verify');
  return url.toString();
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
    ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(schema);
    console.log(`Supabase migration applied from ${path.relative(process.cwd(), schemaPath)}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Supabase migration failed:', error);
  process.exit(1);
});
