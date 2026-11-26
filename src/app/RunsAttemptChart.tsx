'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunsChartData } from '@/lib/dashboard-read-model';
import { fmtSeconds } from '@/lib/format';

const SLOT = 8;
// Keep each scroll track well below browser scroll-width limits.
const SEGMENT = 100000;

export default function RunsAttemptChart({ chart }: { chart: RunsChartData }) {
  const { points } = chart;
  const hasPoints = points.length > 0;
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const pending = useRef<{ segment: number; x: number } | null>(null);
  const [segment, setSegment] = useState(0);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(800);
  const [selected, setSelected] = useState(0);
  const stats = useMemo(() => {
    let max = 1, missing = 0;
    for (const p of points) {
      if (p[4] == null || !Number.isFinite(p[4]) || p[4] < 0) missing++;
      else max = Math.max(max, p[4]);
    }
    return { max, missing };
  }, [points]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const resize = () => setWidth(el.clientWidth || 800);
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(el);
    return () => { observer?.disconnect(); cancelAnimationFrame(frame.current); };
  }, [hasPoints]);
  const effectiveSegment = Math.min(segment, Math.max(0, Math.ceil(points.length / SEGMENT) - 1));
  const effectiveSelected = Math.min(selected, Math.max(0, points.length - 1));
  const base = effectiveSegment * SEGMENT;
  const count = Math.max(0, Math.min(SEGMENT, points.length - base));
  const effectiveLeft = segment !== effectiveSegment ? 0 : Math.min(left, Math.max(0, count * SLOT - width));
  // Only track and geometry changes may reconcile the browser position.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    const el = viewport.current;
    if (segment !== effectiveSegment) {
      pending.current = null;
      setSegment(effectiveSegment);
      if (el) el.scrollLeft = 0;
    } else if (el && pending.current?.segment === effectiveSegment) {
      el.scrollLeft = pending.current.x;
      pending.current = null;
    } else if (el && el.scrollLeft > Math.max(0, count * SLOT - width)) {
      el.scrollLeft = Math.max(0, count * SLOT - width);
    }
    if (el) setLeft(el.scrollLeft);
  }, [effectiveSegment, segment, count, width]);
  useLayoutEffect(() => {
    if (selected !== effectiveSelected) setSelected(effectiveSelected);
  }, [selected, effectiveSelected]);
  useLayoutEffect(() => () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, [effectiveSegment, hasPoints]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const start = Math.max(0, Math.floor(effectiveLeft / SLOT) - 4);
  const end = Math.min(count, Math.ceil((effectiveLeft + width) / SLOT) + 4);
  function go(index: number) {
    const next = Math.max(0, Math.min(points.length - 1, index));
    const nextSegment = Math.floor(next / SEGMENT);
    setSelected(next);
    if (nextSegment !== effectiveSegment) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = { segment: nextSegment, x: (next % SEGMENT) * SLOT };
      setSegment(nextSegment);
      return;
    }
    const x = (next % SEGMENT) * SLOT;
    const el = viewport.current;
    if (el) {
      if (x < el.scrollLeft || x + SLOT > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = x;
        setLeft(el.scrollLeft);
      }
    }
  }
  if (!points.length) return <div className="py-12 text-center text-sm text-neutral-500">No attempts in this window.</div>;
  const p = points[Math.min(selected, points.length - 1)];
  const detail = (point: typeof p) => `${chart.repos[point[0]]} · ${point[1]} #${point[2]} · ${point[3] == null ? 'Unknown window time' : new Date(point[3]).toISOString()} · ${chart.outcomes[point[5]]} · ${point[4] == null || !Number.isFinite(point[4]) || point[4] < 0 ? 'Unknown runtime' : fmtSeconds(point[4])}`;
  return <div>
    <div className="text-xs text-neutral-500 dark:text-neutral-400">Max: {fmtSeconds(stats.max)} · {points.length.toLocaleString()} attempts · {stats.missing.toLocaleString()} missing or invalid durations. Slots follow UTC order, not elapsed time.</div>
    <div className="flex gap-2 text-xs"><button type="button" disabled={effectiveSegment === 0} onClick={() => go(base - 1)}>Previous segment</button><button type="button" disabled={base + count >= points.length} onClick={() => go(base + count)}>Next segment</button></div>
    <div ref={viewport} className="overflow-x-auto" tabIndex={0} role="slider" aria-label="Attempt runtime, use arrow keys or Home and End" aria-valuemin={1} aria-valuemax={points.length} aria-valuenow={Math.min(selected + 1, points.length)} aria-valuetext={detail(p)} onKeyDown={e => {
      const target = e.key === 'ArrowRight' ? effectiveSelected + 1 : e.key === 'ArrowLeft' ? effectiveSelected - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : null;
      if (target !== null) { e.preventDefault(); go(target); }
    }} onScroll={e => { const el = e.currentTarget; if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setLeft(el.scrollLeft); }); }}>
      <div style={{ width: count * SLOT, height: 230, position: 'relative' }}>
        <svg aria-hidden="true" width={(end - start) * SLOT} height="230" style={{ position: 'absolute', left: start * SLOT, top: 0 }}>
          {points.slice(base + start, base + end).map((point, i) => {
            const duration = point[4];
            const unknown = duration == null || !Number.isFinite(duration) || duration < 0;
            const color = chart.outcomes[point[5]] === 'success' ? '#059669' : chart.outcomes[point[5]] === 'failure' ? '#dc2626' : '#6b7280';
            const x = i * SLOT + SLOT / 2;
            return <g key={base + start + i} onMouseEnter={() => setSelected(base + start + i)}>
              <rect x={x - 4} y="0" width="8" height="230" fill="transparent" />
              {unknown ? <path d={`M${x} 211 l3 4 -3 4 -3 -4 Z`} fill="none" stroke={color} strokeWidth="1.5" /> : duration === 0 ? <circle cx={x} cy="202" r="3" fill={color} /> : <rect x={x - 2} y={202 - Math.max(2, 195 * duration / stats.max)} width="4" height={Math.max(2, 195 * duration / stats.max)} fill={color} />}
              <title>{detail(point)}</title>
            </g>;
          })}
        </svg>
      </div>
    </div>
    <div className="min-h-5 text-xs text-neutral-700 dark:text-neutral-300" aria-live="polite">{detail(p)}</div>
  </div>;
}
