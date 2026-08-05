import { createClient } from '@libsql/client';

const migrations: Array<[table: string, column: string, definition: string]> = [
  ['jobs', 'labels_json', 'TEXT'],
  ['jobs', 'runner_id', 'INTEGER'],
  ['jobs', 'runner_name', 'TEXT'],
  ['jobs', 'runner_group_id', 'INTEGER'],
  ['jobs', 'runner_group_name', 'TEXT'],
  ['jobs', 'resource_model', 'TEXT'],
  ['jobs', 'resource_count', 'INTEGER'],
  ['workflow_jobs', 'labels_json', 'TEXT'],
  ['workflow_jobs', 'runner_id', 'INTEGER'],
  ['workflow_jobs', 'runner_name', 'TEXT'],
  ['workflow_jobs', 'runner_group_id', 'INTEGER'],
  ['workflow_jobs', 'runner_group_name', 'TEXT'],
  ['workflow_jobs', 'resource_model', 'TEXT'],
  ['workflow_jobs', 'resource_count', 'INTEGER'],
];

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.log('Skipping Turso migration: TURSO_DATABASE_URL is not set.');
} else {
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    for (const [table, column, definition] of migrations) {
      const { rows } = await client.execute(`SELECT name FROM pragma_table_info('${table}')`);
      if (rows.some((row) => row.name === column)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Added ${table}.${column}`);
    }
  } finally {
    client.close();
  }
}
