import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import RunsAttemptChart from './RunsAttemptChart';
import type { RunsChartData } from '@/lib/dashboard-read-model';

it('preserves a pending native scroll through hover', () => {
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (n: number) => queue.delete(n));
  try {
    const chart: RunsChartData = { repos: ['r'], outcomes: ['success'], points: Array.from({ length: 1000 }, (_, i) => [0, String(i), 1, 0, 1, 0]) };
    const { container, unmount } = render(<RunsAttemptChart chart={chart} />);
    const slider = screen.getByRole('slider');
    let scroll = 0;
    const writes: number[] = [];
    Object.defineProperty(slider, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(slider, 'scrollLeft', { configurable: true, get: () => scroll, set: (v: number) => { writes.push(v); scroll = v; } });
    queue.clear(); writes.length = 0;
    scroll = 160;
    fireEvent.scroll(slider);
    const frameId = [...queue.keys()][0];
    expect(frameId).toBeDefined();
    act(() => { fireEvent.mouseEnter(container.querySelectorAll('svg g')[21]); });
    expect(slider.getAttribute('aria-valuenow')).toBe('22');
    expect(scroll).toBe(160);
    expect(writes).toEqual([]);
    expect(queue.has(frameId)).toBe(true);
    act(() => { const cb = queue.get(frameId)!; queue.delete(frameId); cb(0); });
    expect(scroll).toBe(160);
    expect(writes).toEqual([]);
    expect(container.querySelector('svg')?.style.left).toBe('128px');
    expect(slider.getAttribute('aria-valuenow')).toBe('22');
    unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('keeps dense attempts in distinct slots and reaches the last identity', () => {
  const chart: RunsChartData = { repos: ['owner/repo'], outcomes: ['success', 'failure'], points: Array.from({ length: 30000 }, (_, i) => [0, String(i), 1, 0, i === 0 ? 0 : i === 1 ? null : 0.001, i % 2]) };
  const { container } = render(<RunsAttemptChart chart={chart} />);
  const groups = container.querySelectorAll('svg g');
  expect(groups.length).toBeLessThan(200);
  expect(groups[0].querySelector('circle')).not.toBeNull();
  expect(groups[1].querySelector('path')).not.toBeNull();
  expect(groups[0].querySelector('rect')?.getAttribute('x')).toBe('0');
  expect(groups[1].querySelector('rect')?.getAttribute('x')).toBe('8');
  const slider = screen.getByRole('slider');
  fireEvent.keyDown(slider, { key: 'End' });
  expect(slider.getAttribute('aria-valuetext')).toContain('29999 #1');
  expect(container.querySelector('svg title')?.textContent).toBeTruthy();
});


it('commits the new track before restoring scroll and clamps after filtering', () => {
  const make = (n: number): RunsChartData => ({ repos: ['r'], outcomes: ['success'], points: Array.from({ length: n }, (_, i) => [0, String(i), 1, 0, 1, 0]) });
  const { container, rerender } = render(<RunsAttemptChart chart={make(100200)} />);
  const slider = screen.getByRole('slider');
  let scroll = 0;
  Object.defineProperty(slider, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(slider, 'scrollLeft', { configurable: true, get: () => scroll, set: (v: number) => { scroll = Math.max(0, Math.min(v, parseInt((slider.firstChild as HTMLElement).style.width) - 800)); } });
  fireEvent.click(screen.getByText('Next segment'));
  fireEvent.click(screen.getByText('Previous segment'));
  expect(scroll).toBe(799200);
  expect(container.querySelector('svg')?.textContent).toContain('99999 #1');
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(scroll).toBe(0);
  expect(container.querySelector('svg')?.textContent).toContain('100000 #1');
  fireEvent.keyDown(slider, { key: 'ArrowLeft' });
  expect(scroll).toBe(799200);
  fireEvent.click(screen.getByText('Next segment'));
  fireEvent.keyDown(slider, { key: 'End' });
  rerender(<RunsAttemptChart chart={make(12)} />);
  expect((slider.firstChild as HTMLElement).style.width).toBe('96px');
  expect(scroll).toBe(0);
  expect(container.querySelectorAll('svg g')).toHaveLength(12);
  expect((screen.getByText('Previous segment') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Next segment') as HTMLButtonElement).disabled).toBe(true);
});


it('clamps the viewport when the current segment shrinks', () => {
  const make = (n: number): RunsChartData => ({ repos: ['r'], outcomes: ['success'], points: Array.from({ length: n }, (_, i) => [0, String(i), 1, 0, 1, 0]) });
  const { container, rerender } = render(<RunsAttemptChart chart={make(1000)} />);
  const slider = screen.getByRole('slider');
  let scroll = 0;
  Object.defineProperty(slider, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(slider, 'scrollLeft', { configurable: true, get: () => scroll, set: (v: number) => { scroll = Math.max(0, Math.min(v, Math.max(0, parseInt((slider.firstChild as HTMLElement).style.width) - 800))); } });
  fireEvent.keyDown(slider, { key: 'End' });
  rerender(<RunsAttemptChart chart={make(200)} />);
  expect(scroll).toBe(800);
  expect(container.querySelector('svg')?.textContent).toContain('199 #1');
  expect(slider.getAttribute('aria-valuetext')).toContain('199 #1');
});
