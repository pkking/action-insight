import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ThemeToggle from './ThemeToggle';

let systemDark = false;
let changeListener: ((event: MediaQueryListEvent) => void) | undefined;

beforeEach(() => {
  systemDark = false;
  changeListener = undefined;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    get matches() { return systemDark; },
    addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
      changeListener = listener;
    },
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => vi.unstubAllGlobals());

describe('ThemeToggle', () => {
  it('persists the selected light or dark theme and applies it to the document', async () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('action-insight-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('action-insight-theme')).toBe('light');
  });

  it('follows operating-system changes when System is selected', async () => {
    render(<ThemeToggle />);

    await waitFor(() => expect(changeListener).toBeTypeOf('function'));
    expect(document.documentElement.dataset.theme).toBe('light');

    systemDark = true;
    changeListener?.({ matches: true } as MediaQueryListEvent);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
