'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'action-insight-theme';

function applyTheme(preference: ThemePreference, isDarkSystemTheme: boolean) {
  document.documentElement.dataset.theme =
    preference === 'system'
      ? isDarkSystemTheme ? 'dark' : 'light'
      : preference;
}

function getColorSchemeQuery() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

const options: Array<{
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

export default function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'system';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : 'system';
  });

  useEffect(() => {
    const mediaQuery = getColorSchemeQuery();
    const syncSystemTheme = () => applyTheme(preference, mediaQuery?.matches ?? false);

    syncSystemTheme();
    if (preference !== 'system' || !mediaQuery) return;
    mediaQuery.addEventListener('change', syncSystemTheme);
    return () => mediaQuery.removeEventListener('change', syncSystemTheme);
  }, [preference]);

  function selectTheme(nextPreference: ThemePreference) {
    setPreference(nextPreference);
    window.localStorage.setItem(STORAGE_KEY, nextPreference);
    applyTheme(nextPreference, getColorSchemeQuery()?.matches ?? false);
  }

  return (
    <div
      className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
      role="group"
      aria-label="Theme"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => selectTheme(value)}
          aria-pressed={preference === value}
          aria-label={`${label} theme`}
          title={`${label} theme`}
          suppressHydrationWarning
          className={`rounded-md p-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
            preference === value
              ? 'bg-white text-blue-600 shadow-sm dark:bg-neutral-700 dark:text-blue-300'
              : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          }`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
