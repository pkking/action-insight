'use client';

import { useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ExternalLink } from 'lucide-react';

import type { CiCycle, CycleWallStats } from '@/lib/ci-cycles';
import { computeCycleBusySeconds } from '@/lib/ci-cycles';
import { fmtDurationAuto, fmtSeconds } from '@/lib/format';

const RUN_BAR_COLORS: Record<string, string> = {
  success: 'bg-emerald-500 dark:bg-emerald-400',
  failure: 'bg-red-500 dark:bg-red-400',
  cancelled: 'bg-amber-500 dark:bg-amber-400',
};

const TOOLTIP_WIDTH = 288;

type HoverState = { index: number; x: number; y: number; maxX: number } | null;

/**
 * Gantt view of a PR's CI cycles on one absolute time axis (ADR-020).
 * Each row is one push batch; each lane inside a row is one workflow run,
 * colored by conclusion. Idle gaps between cycles stay visible, and the
 * header separates the PR span into busy (interval union) vs idle.
 * Tooltips are mouse- AND keyboard-accessible (rows are focusable) and
 * stick to facts: failed job names, never a fabricated root cause.
 */
export function CiCycleGantt({
  cycles,
  stats,
  mergedAt,
}: {
  cycles: CiCycle[];
  stats: CycleWallStats;
  mergedAt?: string;
}) {
  const [hover, setHover] = useState<HoverState>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const chronological = useMemo(() => [...cycles].reverse(), [cycles]);

  const span = useMemo(() => {
    if (chronological.length === 0) return null;
    const starts = chronological.map((c) => Date.parse(c.startedAt));
    const ends = chronological.map((c) =>
      c.endedAt ? Date.parse(c.endedAt) : Number.NEGATIVE_INFINITY,
    );
    const mergedMs = mergedAt ? Date.parse(mergedAt) : Number.NEGATIVE_INFINITY;
    const start = Math.min(...starts);
    let end = Math.max(...ends, mergedMs);
    if (!Number.isFinite(end) || end <= start) end = start + 60_000;
    return { start, end };
  }, [chronological, mergedAt]);

  const busySeconds = useMemo(() => computeCycleBusySeconds(cycles), [cycles]);

  if (chronological.length === 0 || !span) {
    return (
      <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
        No CI cycles — no associated runs for this PR.
      </div>
    );
  }

  const spanSeconds = Math.round((span.end - span.start) / 1000);
  const idleSeconds = Math.max(0, spanSeconds - busySeconds);
  const pct = (ms: number) =>
    Math.min(
      100,
      Math.max(0, ((ms - span.start) / (span.end - span.start)) * 100),
    );
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(
    (f) => new Date(span.start + (span.end - span.start) * f),
  );
  const mergePct = mergedAt ? pct(Date.parse(mergedAt)) : null;

  const positionFromEvent = (e: React.MouseEvent | React.FocusEvent<HTMLElement>) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const containerRect = container.getBoundingClientRect();
    const targetRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.type === 'focus') {
      return {
        x: targetRect.left - containerRect.left + targetRect.width / 2,
        y: targetRect.top - containerRect.top,
        maxX: containerRect.width,
      };
    }
    return {
      x: (e as React.MouseEvent).clientX - containerRect.left,
      y: (e as React.MouseEvent).clientY - containerRect.top,
      maxX: containerRect.width,
    };
  };

  const hoveredCycle = hover !== null ? chronological[hover.index] : null;
  const tooltipLeft =
    hover !== null
      ? Math.max(4, Math.min(hover.x - TOOLTIP_WIDTH / 2, hover.maxX - TOOLTIP_WIDTH - 4))
      : 0;
  const tooltipFlipped = hover !== null && hover.y > 210;

  return (
    <div className="relative" ref={containerRef}>
      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
        PR span {fmtDurationAuto(spanSeconds)} = CI cycles (union){' '}
        {fmtDurationAuto(busySeconds)} + idle between pushes{' '}
        {fmtDurationAuto(idleSeconds)} · median wall{' '}
        {fmtSeconds(stats.medianWallSeconds)}
        {stats.openCycleCount > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {' '}
            · {stats.openCycleCount} open
          </span>
        )}
      </div>

      <div className="mt-2 max-h-72 overflow-y-auto">
        <div className="relative min-w-0">
          {chronological.map((cycle, index) => {
            const laneCount = Math.max(1, cycle.runs.length);
            const rowHeight = laneCount * 10 + 6;
            const outlier =
              stats.cycleCount >= 3 &&
              cycle.wallSeconds !== undefined &&
              stats.medianWallSeconds > 0 &&
              cycle.wallSeconds > 2 * stats.medianWallSeconds;
            return (
              <div
                key={`${cycle.startedAt}:${cycle.runs[0]?.runId ?? 0}`}
                data-testid="cycle-row"
                tabIndex={0}
                aria-label={`CI cycle ${cycle.startedAt}, wall ${fmtSeconds(cycle.wallSeconds)}`}
                className="relative flex cursor-default items-center gap-2 rounded-sm outline-none focus:bg-blue-50/60 dark:focus:bg-blue-950/40"
                style={{ height: rowHeight }}
                onMouseEnter={(e) =>
                  setHover({ index, ...positionFromEvent(e) })
                }
                onMouseMove={(e) =>
                  setHover({ index, ...positionFromEvent(e) })
                }
                onMouseLeave={() => setHover(null)}
                onFocus={(e) => setHover({ index, ...positionFromEvent(e) })}
                onBlur={() => setHover(null)}
              >
                <span className="w-[76px] shrink-0 font-mono text-[10px] leading-none text-neutral-500 dark:text-neutral-400">
                  {format(parseISO(cycle.startedAt), 'MM-dd HH:mm')}
                </span>
                <div className="relative h-full min-w-0 flex-1">
                  {cycle.runs.map((run, lane) => {
                    const left = pct(Date.parse(run.startedAt));
                    const runEndMs = run.endedAt
                      ? Date.parse(run.endedAt)
                      : span.end;
                    const width = Math.max(0.4, pct(runEndMs) - left);
                    const colorClass =
                      RUN_BAR_COLORS[run.conclusion] ??
                      (run.endedAt
                        ? 'bg-neutral-400 dark:bg-neutral-500'
                        : 'border border-dashed border-neutral-400 bg-neutral-200 dark:bg-neutral-700');
                    return (
                      <div
                        key={`${run.runId}:${run.runAttempt}`}
                        data-testid="cycle-bar"
                        data-conclusion={run.conclusion}
                        className={`absolute rounded-sm ${colorClass}`}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          top: 3 + lane * 10,
                          height: 7,
                        }}
                      />
                    );
                  })}
                </div>
                {outlier && (
                  <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] leading-4 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                    outlier
                  </span>
                )}
              </div>
            );
          })}

          {mergePct !== null && (
            <div
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-blue-400 dark:border-blue-500"
              style={{ left: `${mergePct}%` }}
            >
              <span className="absolute -top-0.5 left-1 whitespace-nowrap text-[9px] text-blue-500 dark:text-blue-400">
                merged
              </span>
            </div>
          )}

          <div className="mt-1 flex gap-2 pl-[84px]">
            <div className="relative h-3 min-w-0 flex-1">
              {ticks.map((tick) => (
                <span
                  key={tick.getTime()}
                  className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-neutral-400 dark:text-neutral-500"
                  style={{ left: `${pct(tick.getTime())}%` }}
                >
                  {format(tick, 'MM-dd')}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {hoveredCycle && hover && (
        <div
          data-testid="cycle-tooltip"
          role="tooltip"
          className="pointer-events-none absolute z-10 w-72 rounded-lg border border-neutral-200 bg-white p-2.5 text-[11px] shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          style={{
            left: tooltipLeft,
            top: tooltipFlipped ? hover.y - 8 : hover.y + 16,
            transform: tooltipFlipped ? 'translateY(-100%)' : undefined,
          }}
        >
          <div className="font-semibold text-neutral-700 dark:text-neutral-200">
            {format(parseISO(hoveredCycle.startedAt), 'yyyy-MM-dd HH:mm')} · wall{' '}
            <span className="font-mono">
              {hoveredCycle.wallSeconds === undefined
                ? 'open'
                : fmtSeconds(hoveredCycle.wallSeconds)}
            </span>
          </div>
          <div className="mt-1.5 space-y-1">
            {hoveredCycle.runs.map((run) => (
              <div key={`${run.runId}:${run.runAttempt}`} className="leading-snug">
                <div className="flex items-center gap-1">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-sm ${
                      RUN_BAR_COLORS[run.conclusion] ?? 'bg-neutral-400'
                    }`}
                  />
                  <span className="truncate text-neutral-700 dark:text-neutral-200">
                    {run.workflowFile ?? 'workflow'}
                    {run.branchMatched && (
                      <span title="branch-matched attribution">*</span>
                    )}
                  </span>
                  {run.htmlUrl && (
                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto shrink-0 text-blue-500 hover:underline dark:text-blue-400"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                <div className="pl-3 text-neutral-500 dark:text-neutral-400">
                  {run.conclusion} ·{' '}
                  <span className="font-mono">
                    {run.wallSeconds === undefined ? 'open' : fmtSeconds(run.wallSeconds)}
                  </span>
                  {run.headSha && (
                    <span className="ml-1 font-mono text-neutral-400 dark:text-neutral-500">
                      {run.headSha.slice(0, 7)}
                    </span>
                  )}
                </div>
                {run.conclusion === 'failure' && run.failedJobCount > 0 && (
                  <div className="pl-3 text-red-500 dark:text-red-400">
                    failed jobs ({run.failedJobCount}):{' '}
                    {run.failedJobNames.join(', ')}
                    {run.failedJobCount > run.failedJobNames.length && ' …'}
                    <div className="text-neutral-400 dark:text-neutral-500">
                      root cause needs the run log
                    </div>
                  </div>
                )}
                {run.conclusion === 'failure' && run.failedJobCount === 0 && (
                  <div className="pl-3 text-neutral-400 dark:text-neutral-500">
                    no failed job collected for this run
                  </div>
                )}
                {run.cancelledJobCount > 0 && (
                  <div className="pl-3 text-amber-600 dark:text-amber-400">
                    {run.cancelledJobCount} cancelled job(s)
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
