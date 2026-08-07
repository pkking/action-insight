import { Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;

/** Singleton pg.Pool — reads PG_DATABASE_URL, defaults to local Docker Compose PG. */
const DEFAULT_PG_URL = 'postgresql://action_insight:action_insight@localhost:5433/action_insight';

function getPool(): Pool {
  if (pool) return pool;

  pool = new Pool({ connectionString: process.env.PG_DATABASE_URL ?? DEFAULT_PG_URL, max: 10 });
  return pool;
}

/** pg.PoolClient alias so ETL modules can type shared write helpers. */
export type DbClient = PoolClient;

/**
 * Acquire a client from the pool. The caller MUST call `.release()`
 * when done (use try/finally). For fire-and-forget single queries,
 * use `getPool().query()` directly instead.
 */
export function getDatabaseClient(): Promise<PoolClient> {
  return getPool().connect();
}

/** Run a single query without manual client lifecycle management. */
export async function query(text: string, params?: unknown[]) {
  return getPool().query(text, params);
}

/** Helper: get repo_id from owner/repo. */
export async function getRepoId(owner: string, repo: string): Promise<number> {
  const { rows } = await query(
    'SELECT id FROM repos WHERE owner = $1 AND repo = $2',
    [owner, repo],
  );
  if (rows.length === 0) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  return Number(rows[0].id);
}

