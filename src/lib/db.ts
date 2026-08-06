import { type Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;

/** Singleton pg.Pool — reads PG_DATABASE_URL. */
function getPool(): Pool {
  if (pool) return pool;

  const url = process.env.PG_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Database connection not configured. Please set PG_DATABASE_URL ' +
      '(e.g., postgresql://user:pass@localhost:5432/dbname).'
    );
  }

  pool = new Pool({ connectionString: url, max: 10 });
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

