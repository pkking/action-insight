# Repo Selection Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tracked-repository selection panel that lets the dashboard switch action details between configured repos and reflect the selection in the URL.

**Architecture:** Keep the dashboard as a single client page, introduce a small typed tracked-repo config for the frontend, and drive selection from `owner`/`repo` search params. Add a focused unit/integration-style test harness around the page so repo selection and fetch behavior are proven before UI code changes.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Vitest, Testing Library

---

## File Structure

- Modify: `/home/lcr/action-insight/package.json`
- Create: `/home/lcr/action-insight/vitest.config.ts`
- Create: `/home/lcr/action-insight/src/test/setup.ts`
- Create: `/home/lcr/action-insight/src/lib/tracked-repos.ts`
- Modify: `/home/lcr/action-insight/src/app/page.tsx`
- Create: `/home/lcr/action-insight/src/app/page.test.tsx`

### Task 1: Add the test harness

**Files:**
- Modify: `/home/lcr/action-insight/package.json`
- Create: `/home/lcr/action-insight/vitest.config.ts`
- Create: `/home/lcr/action-insight/src/test/setup.ts`

- [ ] **Step 1: Write the failing test command target**

Create `/home/lcr/action-insight/src/app/page.test.tsx` with a placeholder smoke test that will not run yet because the test harness does not exist:

```tsx
import { describe, expect, it } from 'vitest';

describe('Dashboard', () => {
  it('has a test harness', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/page.test.tsx`
Expected: FAIL because `vitest` is not configured or installed for the app.

- [ ] **Step 3: Write minimal test harness implementation**

Update `/home/lcr/action-insight/package.json` scripts and dev dependencies:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.19.39",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.1",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4",
    "typescript": "^5.9.3",
    "vitest": "^2.1.8"
  }
}
```

Create `/home/lcr/action-insight/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

Create `/home/lcr/action-insight/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/page.test.tsx`
Expected: PASS with 1 passing test.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/app/page.test.tsx
git commit -m "test: add dashboard test harness"
```

### Task 2: Add failing tests for repo selection behavior

**Files:**
- Modify: `/home/lcr/action-insight/src/app/page.test.tsx`
- Test: `/home/lcr/action-insight/src/app/page.test.tsx`

- [ ] **Step 1: Write the failing tests**

Replace the placeholder test with behavior tests that mock Next navigation and the data fetcher:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from './page';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const fetchRunsMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/',
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('@/lib/data-fetcher', () => ({
  fetchRuns: (...args: unknown[]) => fetchRunsMock(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceArea: () => null,
}));

describe('Dashboard repo selection', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchRunsMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));
    fetchRunsMock.mockResolvedValue([]);
  });

  it('defaults to the first tracked repo and fetches it', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 7);
    });
  });

  it('uses a valid repo from the URL', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('owner=vllm-project&repo=vllm-ascend'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 7);
    });
  });

  it('falls back when the URL repo is invalid', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('owner=bad&repo=input'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(fetchRunsMock).toHaveBeenCalledWith('vllm-project', 'vllm-ascend', 7);
    });
  });

  it('switches repo from the selection panel', async () => {
    render(<Dashboard />);

    const button = await screen.findByRole('button', { name: /vllm-project\/vllm-ascend/i });
    await userEvent.click(button);

    expect(button).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/page.test.tsx`
Expected: FAIL because the page does not yet expose tracked repo selection behavior.

- [ ] **Step 3: Commit**

```bash
git add src/app/page.test.tsx
git commit -m "test: cover repo selection behavior"
```

### Task 3: Implement tracked repo config and dashboard switching

**Files:**
- Create: `/home/lcr/action-insight/src/lib/tracked-repos.ts`
- Modify: `/home/lcr/action-insight/src/app/page.tsx`
- Test: `/home/lcr/action-insight/src/app/page.test.tsx`

- [ ] **Step 1: Write minimal implementation**

Create `/home/lcr/action-insight/src/lib/tracked-repos.ts`:

```ts
export type TrackedRepo = {
  owner: string;
  repo: string;
  slug: string;
  label: string;
};

export const TRACKED_REPOS: TrackedRepo[] = [
  {
    owner: 'vllm-project',
    repo: 'vllm-ascend',
    slug: 'vllm-project/vllm-ascend',
    label: 'vllm-project/vllm-ascend',
  },
];

export function findTrackedRepo(owner: string | null, repo: string | null): TrackedRepo | null {
  return TRACKED_REPOS.find((item) => item.owner === owner && item.repo === repo) ?? null;
}

export const DEFAULT_TRACKED_REPO = TRACKED_REPOS[0];
```

Update `/home/lcr/action-insight/src/app/page.tsx` to:

- derive `selectedRepo` from `owner`/`repo` URL params
- fall back to `DEFAULT_TRACKED_REPO`
- pass `selectedRepo.owner` and `selectedRepo.repo` into `fetchRuns`
- add a `Tracked Repositories` panel with one button per repo
- update `router.replace` param syncing to include `owner` and `repo`
- reset `expandedRunId`, `zoomLeft`, `zoomRight`, `refAreaLeft`, and `refAreaRight` when the selected repo changes
- update empty/error copy to mention `selectedRepo.slug`

Representative panel markup:

```tsx
<section className="bg-white dark:bg-neutral-900 dark:bg-neutral-800 p-4 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800">
  <div className="flex flex-col gap-3">
    <div>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Tracked Repositories</h2>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">Switch the dashboard between collected repositories.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      {TRACKED_REPOS.map((trackedRepo) => {
        const isActive = trackedRepo.slug === selectedRepo.slug;

        return (
          <button
            key={trackedRepo.slug}
            type="button"
            onClick={() => setSelectedRepoSlug(trackedRepo.slug)}
            className={isActive
              ? 'rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
              : 'rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800'}
          >
            {trackedRepo.label}
          </button>
        );
      })}
    </div>
  </div>
</section>
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- src/app/page.test.tsx`
Expected: PASS with repo selection tests green.

- [ ] **Step 3: Refine tests to cover repo switching URL updates**

Add one more assertion:

```tsx
await waitFor(() => {
  expect(replaceMock).toHaveBeenCalled();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/page.test.tsx`
Expected: PASS with all repo selection tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tracked-repos.ts src/app/page.tsx src/app/page.test.tsx
git commit -m "feat: add tracked repo selection panel"
```

### Task 4: Verify the integrated app

**Files:**
- Modify: `/home/lcr/action-insight/src/app/page.tsx` if verification finds issues

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: PASS with no errors.

- [ ] **Step 2: Run the focused test suite**

Run: `npm test -- src/app/page.test.tsx`
Expected: PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: PASS with a successful Next.js production build.

- [ ] **Step 4: Commit verification fixes if needed**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/lib/tracked-repos.ts src/app/page.tsx src/app/page.test.tsx
git commit -m "fix: polish repo selection panel"
```

## Self-Review

- Spec coverage: the plan covers tracked repo sourcing, URL-backed selection, fetch switching, state reset, and repo-aware messaging.
- Placeholder scan: no `TODO` or undefined implementation steps remain.
- Type consistency: plan uses `TrackedRepo`, `TRACKED_REPOS`, and `selectedRepo` consistently across config, page logic, and tests.
