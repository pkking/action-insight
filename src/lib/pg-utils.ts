/** Convert SQLite-style ? placeholders to PostgreSQL $N numbered placeholders. */
export function toPgSql(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Build a PostgreSQL IN-clause placeholder string: $1,$2,... for N items. */
export function pgPlaceholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(',');
}
