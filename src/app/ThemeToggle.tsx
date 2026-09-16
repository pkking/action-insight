'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';

const storageKey = 'action-insight-theme';

function storedPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(storageKey);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function resolveTheme(preference: ThemePreference) {
  return preference === 'system'
    ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : preference;
}

function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved;
}

const options: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export default function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);

  useEffect(() => {
    applyTheme(preference);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const handleChange = () => {
      if (preference === 'system') applyTheme('system');
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [preference]);

  function selectTheme(next: ThemePreference) {
    setPreference(next);
    window.localStorage.setItem(storageKey, next);
    applyTheme(next);
  }

  return (
    <div
      aria-label="Theme"
      className="flex items-center rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-700 dark:bg-neutral-950"
      role="group"
    >
      {options.map(({ value, label, icon: Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={`${label} theme`}
            aria-pressed={selected}
            onClick={() => selectTheme(value)}
            className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
              selected
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
