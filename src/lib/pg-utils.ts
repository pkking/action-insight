/** Convert SQLite-style ? placeholders to PostgreSQL $N numbered placeholders. */
export function toPgSql(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Build a PostgreSQL IN-clause placeholder string starting at $startIndex. */
export function pgPlaceholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, i) => `$${startIndex + i}`).join(',');
}

/** Build PostgreSQL row-value placeholders, e.g. `($1,$2),($3,$4)`. */
export function pgTuplePlaceholders(tupleCount: number, startIndex = 1): string {
  return Array.from(
    { length: tupleCount },
    (_, i) => `($${startIndex + i * 2},$${startIndex + i * 2 + 1})`,
  ).join(',');
}
