/** Shared duration formatters (dashboard cards, drill-downs, Gantt). */

export function fmtSeconds(seconds?: number): string {
  if (seconds === undefined) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function fmtMachineHours(hours?: number): string {
  if (hours === undefined) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

/** Auto-scale: minutes → hours → days (for spans like PR lifetime). */
export function fmtDurationAuto(seconds?: number): string {
  if (seconds === undefined) return '—';
  if (seconds < 3600) return fmtSeconds(seconds);
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
