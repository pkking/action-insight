export function diffSeconds(
  start?: string | null,
  end?: string | null,
  { clampNegative = false }: { clampNegative?: boolean } = {}
): number | undefined {
  if (!start || !end) {
    return undefined;
  }

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return undefined;
  }

  if (endMs < startMs) {
    return clampNegative ? 0 : undefined;
  }

  return Math.round((endMs - startMs) / 1000);
}
