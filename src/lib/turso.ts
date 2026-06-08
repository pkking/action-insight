import { createClient, type Client } from '@libsql/client';

let tursoClient: Client | null = null;

export function getTursoClient(): Client {
  if (tursoClient) return tursoClient;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      'Database connection not configured. Please set TURSO_DATABASE_URL ' +
      '(e.g., file:./data.db for local, or libsqls://... for remote Turso).'
    );
  }

  tursoClient = createClient({ url, authToken });
  return tursoClient;
}

/**
 * Helper: get repo_id from owner/repo.
 */
export async function getRepoId(owner: string, repo: string): Promise<number> {
  const client = getTursoClient();
  const { rows } = await client.execute({
    sql: 'SELECT id FROM repos WHERE owner = ? AND repo = ?',
    args: [owner, repo],
  });
  if (rows.length === 0) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  return Number(rows[0].id);
}
