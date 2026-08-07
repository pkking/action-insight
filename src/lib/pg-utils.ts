/** Convert SQLite-style ? placeholders to PostgreSQL $N numbered placeholders. */
export function toPgSql(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Build a PostgreSQL IN-clause placeholder string starting at $startIndex. */
export function pgPlaceholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, i) => `$${startIndex + i}`).join(',');
}
