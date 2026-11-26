import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import RunsAttemptChart from './RunsAttemptChart';
import type { RunsChartData } from '@/lib/dashboard-read-model';

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
