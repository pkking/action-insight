# Split Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split action-insight into ETL (data collection via GitHub Actions) and Frontend (Vercel-deployed dashboard reading from pre-collected JSON data).

**Architecture:** Single repository with two branches — `main` for frontend code (Vercel), `data` for ETL scripts + daily JSON data files. Frontend reads from `data` branch via GitHub Raw URLs.

**Tech Stack:** Next.js 16, TypeScript, Tailwind CSS, Recharts (frontend); Node.js 20, tsx, Octokit (ETL).

**Spec:** `docs/superpowers/specs/2026-04-05-split-architecture-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/types.ts` | Create | Shared TypeScript types (Run, Job, Index, DayData) |
| `src/lib/data-fetcher.ts` | Create | Fetch JSON from `data` branch via GitHub Raw URLs |
| `src/app/page.tsx` | Modify | Replace GitHub API calls with `fetchRuns()`, remove token/localStorage |
| `etl/scripts/collect.ts` | Create | ETL script: fetch from GitHub API, write daily JSON + index |
| `etl/.github/workflows/collect.yml` | Create | GitHub Actions workflow for scheduled data collection |
| `data/index.json` | Create | Initial empty index file |
| `data/.gitkeep` | Create | Placeholder for data directory |

---

### Task 1: Create Shared Types

**Files:**
- Create: `src/lib/types.ts`

- [ ] **Step 1: Create shared TypeScript type definitions**

Create `src/lib/types.ts` with all types from the spec. These types will be used by both the frontend and serve as the reference for ETL output format.

```typescript
// src/lib/types.ts

export interface Index {
  version: number;
  repos: Record<string, RepoIndex>;
  last_updated: string;
}

export interface RepoIndex {
  latest: string;
  files: string[];
  retention_days: number;
}

export interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

export interface Run {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  jobs?: Job[];
}

export interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors (pre-existing errors OK)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared TypeScript types for split architecture"
```

---

### Task 2: Create Data Fetcher Library

**Files:**
- Create: `src/lib/data-fetcher.ts`
- Reference: `src/lib/types.ts`

- [ ] **Step 1: Create data-fetcher.ts**

```typescript
// src/lib/data-fetcher.ts
import type { Index, DayData, Run } from './types';

const OWNER = 'pkking';
const REPO = 'action-insight';
const DATA_BRANCH = 'data';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

export async function fetchIndex(): Promise<Index> {
  const res = await fetch(`${RAW_BASE}/data/index.json`, {
    // Prevent aggressive caching during development
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch index: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchDay(date: string): Promise<DayData> {
  const res = await fetch(`${RAW_BASE}/data/${date}.json`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch data for ${date}: ${res.status}`);
  }
  return res.json();
}

export async function fetchRuns(days: number): Promise<Run[]> {
  const index = await fetchIndex();
  const repoKey = 'vllm-project/vllm-ascend';
  const repoIndex = index.repos[repoKey];
  
  if (!repoIndex) {
    throw new Error(`No data found for repo: ${repoKey}`);
  }

  // Take the most recent `days` files
  const dates = repoIndex.files.slice(0, days);
  
  // Fetch all days in parallel
  const dayData = await Promise.allSettled(
    dates.map(date => fetchDay(date))
  );

  // Aggregate runs, skipping failed days
  const runs: Run[] = [];
  for (const result of dayData) {
    if (result.status === 'fulfilled') {
      runs.push(...result.value.runs);
    }
    // Silently skip failed days (404, network error, etc.)
  }

  return runs;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/data-fetcher.ts
git commit -m "feat: add data-fetcher library for reading from data branch"
```

---

### Task 3: Refactor Frontend — Replace Data Source

**Files:**
- Modify: `src/app/page.tsx` (massive refactor — ~1135 lines → ~900 lines)
- Reference: `src/lib/types.ts`, `src/lib/data-fetcher.ts`

This task removes all GitHub API calls, localStorage caching, and token management. Replaces with `fetchRuns()` calls.

- [ ] **Step 1: Update imports and types at top of file**

Replace the inline `Run` and `Job` type definitions with imports from `types.ts`. Remove unused imports.

```typescript
'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Search, Activity, CheckCircle, XCircle, Clock, Calendar as CalendarIcon, ExternalLink, ChevronDown, ChevronUp, Filter, ArrowUpDown, ArrowDown, ArrowUp, Share2, Info, Settings, ShieldAlert, Key, Trash2, MessageSquare, Eye, EyeOff, LayoutList, AlignLeft, RefreshCw } from 'lucide-react';
import { 
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceArea
} from 'recharts';
import { format, subDays, isAfter, isBefore, startOfDay, endOfDay, parseISO } from 'date-fns';
import { fetchRuns } from '@/lib/data-fetcher';
import type { Run } from '@/lib/types';
```

- [ ] **Step 2: Remove token-related state and effects**

Delete these from `DashboardContent`:
- `const [githubToken, setGithubToken] = useState('')`
- `const [tempToken, setTempToken] = useState('')`
- `const [showToken, setShowToken] = useState(false)`
- The `useEffect` that loads token from localStorage
- The `saveToken()` function
- The `clearToken()` function

- [ ] **Step 3: Remove Settings modal**

Delete the entire `{showSettings && (...)}` block (Settings modal JSX).

Remove `showSettings` state and the Settings button click handler.

- [ ] **Step 4: Replace data fetching logic**

Replace the large `useEffect` that fetches from GitHub API (lines ~298-496) with:

```typescript
  // Fetch data from pre-collected JSON files
  useEffect(() => {
    let isCancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setLoadingProgress(0);
      setError('');
      setRuns([]);
      
      try {
        const runs = await fetchRuns(days);
        
        if (!isCancelled) {
          // Apply date range filter if custom range is set
          const isCustomValid = useCustomRange && startDate && endDate;
          const cutoffDate = isCustomValid ? startOfDay(parseISO(startDate)) : subDays(new Date(), days);
          const endCutoffDate = isCustomValid ? endOfDay(parseISO(endDate)) : new Date();
          
          const filteredRuns = runs.filter(r => 
            isAfter(new Date(r.created_at), cutoffDate) && 
            isBefore(new Date(r.created_at), endCutoffDate)
          );
          
          setRuns(filteredRuns);
          setLoadingProgress(100);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('Failed to load data. ETL may not have run yet.');
          }
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
          setTimeout(() => {
            if (!isCancelled) setLoadingProgress(0);
          }, 500);
        }
      }
    };
    
    fetchData();
    
    return () => {
      isCancelled = true;
    };
  }, [days, useCustomRange, startDate, endDate]);
```

- [ ] **Step 5: Replace `fetchJobsForRun`**

The current `fetchJobsForRun` calls GitHub API for job details. Since our JSON data already includes jobs, replace with:

```typescript
  const fetchJobsForRun = async (runId: number) => {
    // Jobs are already included in the fetched data
    setExpandedRunId(expandedRunId === runId ? null : runId);
  };
```

- [ ] **Step 6: Remove `hasMoreData` state and related logic**

Since we load all available data from JSON files, pagination is no longer needed. Remove:
- `const [hasMoreData, setHasMoreData] = useState(false)`
- All `setHasMoreData()` calls
- The `{hasMoreData && ...}` UI element

- [ ] **Step 7: Remove `repoInput` / `currentRepo` state**

Since data is pre-collected for a specific repo, remove the repo search functionality:
- Remove `repoInput` and `currentRepo` state
- Remove the `<form onSubmit={handleSearch}>` element
- Replace with a static repo display or remove entirely
- Update URL sync to remove `repo` parameter

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 9: Verify lint**

Run: `npm run lint`
Expected: No new errors

- [ ] **Step 10: Commit**

```bash
git add src/app/page.tsx
git commit -m "refactor: replace GitHub API calls with pre-collected data source

- Remove GitHub API fetches, localStorage caching, token management
- Use fetchRuns() from data-fetcher library
- Simplify job details (jobs included in pre-collected data)
- Remove repo search (data is pre-collected for specific repo)"
```

---

### Task 4: Create ETL Pipeline

**Files:**
- Create: `etl/scripts/collect.ts`
- Create: `etl/.github/workflows/collect.yml`
- Create: `data/index.json`
- Create: `data/.gitkeep`

- [ ] **Step 1: Create initial data directory structure**

```bash
mkdir -p data etl/.github/workflows etl/scripts
```

Create `data/index.json`:
```json
{
  "version": 1,
  "repos": {},
  "last_updated": ""
}
```

Create `data/.gitkeep` (empty file to ensure directory exists in git).

- [ ] **Step 2: Create ETL script**

Create `etl/scripts/collect.ts`:

```typescript
// etl/scripts/collect.ts
import { Octokit } from 'octokit';
import { format, subDays, parseISO } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';

interface Run {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  jobs?: Job[];
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
}

interface Index {
  version: number;
  repos: Record<string, { latest: string; files: string[]; retention_days: number }>;
  last_updated: string;
}

interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

const DATA_DIR = path.join(__dirname, '../../data');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

function readIndex(): Index {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return { version: 1, repos: {}, last_updated: '' };
  }
}

function writeIndex(index: Index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function readDayData(date: string): DayData {
  const filePath = path.join(DATA_DIR, `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { date, repo: '', runs: [] };
  }
}

function writeDayData(data: DayData) {
  const filePath = path.join(DATA_DIR, `${data.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const targetRepos = (process.env.TARGET_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90');

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (targetRepos.length === 0) throw new Error('TARGET_REPOS is required');

  const octokit = new Octokit({ auth: token });
  const index = readIndex();

  for (const repo of targetRepos) {
    console.log(`Processing ${repo}...`);
    const [owner, repoName] = repo.split('/');

    // Determine incremental fetch date
    const repoIndex = index.repos[repo];
    const lastUpdated = repoIndex?.latest 
      ? parseISO(repoIndex.latest)
      : subDays(new Date(), retentionDays);

    const createdParam = `created:>=${format(lastUpdated, 'yyyy-MM-dd')}`;
    
    // Fetch runs (paginated)
    const allRuns: Run[] = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
        owner,
        repo,
        per_page: 100,
        page,
        created: createdParam,
      });

      if (data.workflow_runs.length === 0) break;

      for (const run of data.workflow_runs) {
        if (run.status !== 'completed') continue;

        // Fetch jobs for this run
        const { data: jobsData } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
          owner,
          repo,
          run_id: run.id,
        });

        const jobs: Job[] = jobsData.jobs.map((j: any) => {
          const createdMs = j.created_at ? new Date(j.created_at).getTime() : 0;
          const startedMs = j.started_at ? new Date(j.started_at).getTime() : createdMs;
          const completedMs = j.completed_at ? new Date(j.completed_at).getTime() : startedMs;
          return {
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            created_at: j.created_at,
            started_at: j.started_at,
            completed_at: j.completed_at,
            html_url: j.html_url,
            queueDurationInSeconds: Math.max(0, (startedMs - createdMs) / 1000),
            durationInSeconds: Math.max(0, (completedMs - startedMs) / 1000),
          };
        });

        allRuns.push({
          id: run.id,
          name: run.name,
          head_branch: run.head_branch,
          status: run.status,
          conclusion: run.conclusion,
          created_at: run.created_at,
          updated_at: run.updated_at,
          html_url: run.html_url,
          durationInSeconds: (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
          jobs,
        });
      }

      if (data.workflow_runs.length < 100) break;
      page++;
      
      // Rate limit safety
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Group runs by date
    const runsByDate: Record<string, Run[]> = {};
    for (const run of allRuns) {
      const date = format(new Date(run.created_at), 'yyyy-MM-dd');
      if (!runsByDate[date]) runsByDate[date] = [];
      runsByDate[date].push(run);
    }

    // Write day files and update index
    const dates = Object.keys(runsByDate).sort().reverse();
    const files = index.repos[repo]?.files || [];

    for (const date of dates) {
      console.log(`  Writing ${date}.json (${runsByDate[date].length} runs)`);
      const existing = readDayData(date);
      // Merge: new runs overwrite existing by ID
      const runMap = new Map(existing.runs.map(r => [r.id, r]));
      for (const run of runsByDate[date]) runMap.set(run.id, run);
      
      writeDayData({ date, repo, runs: Array.from(runMap.values()) });
      
      if (!files.includes(`${date}.json`)) {
        files.push(`${date}.json`);
      }
    }

    // Sort files newest first
    files.sort().reverse();

    // Update index
    index.repos[repo] = {
      latest: dates[0] || repoIndex?.latest || '',
      files,
      retention_days: retentionDays,
    };
    index.last_updated = new Date().toISOString();

    // Cleanup old files
    const cutoffDate = subDays(new Date(), retentionDays);
    const filesToRemove = files.filter(f => {
      const fileDate = parseISO(f.replace('.json', ''));
      return isBefore(fileDate, cutoffDate);
    });

    for (const file of filesToRemove) {
      const filePath = path.join(DATA_DIR, file);
      if (fs.existsSync(filePath)) {
        console.log(`  Removing old file: ${file}`);
        fs.unlinkSync(filePath);
      }
      const idx = index.repos[repo].files.indexOf(file);
      if (idx > -1) index.repos[repo].files.splice(idx, 1);
    }
  }

  writeIndex(index);
  console.log('Done!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Create GitHub Actions workflow**

Create `etl/.github/workflows/collect.yml`:

```yaml
name: Collect CI Data
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: data
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install tsx octokit date-fns
      - run: npx tsx etl/scripts/collect.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TARGET_REPOS: "vllm-project/vllm-ascend"
          RETENTION_DAYS: 90
      - run: |
          git config user.name "action-insight-bot"
          git config user.email "bot@action-insight.local"
          git add data/
          git diff --staged --quiet || git commit -m "data: update $(date -u +%Y-%m-%d)"
          git push origin data
```

- [ ] **Step 4: Commit ETL files**

```bash
git add etl/ data/
git commit -m "feat: add ETL pipeline for automated data collection

- collect.ts: fetches runs/jobs from GitHub API, writes daily JSON
- collect.yml: GitHub Actions workflow (cron every 6 hours)
- data/index.json: initial empty index"
```

---

### Task 5: Create `data` Branch and Initial Data Population

**Files:**
- Branch operation: create `data` branch from `main`

- [ ] **Step 1: Create data branch**

```bash
git checkout -b data
```

- [ ] **Step 2: Remove frontend code from data branch (keep only ETL + data)**

On the `data` branch, remove everything except `etl/` and `data/`:

```bash
# Remove frontend files but keep etl and data
git rm -r src/ public/ package.json package-lock.json tsconfig.json next.config.* eslint.config.* postcss.config.* .gitignore README.md AGENTS.md CLAUDE.md docs/
git commit -m "data: remove frontend code, keep ETL pipeline only"
```

- [ ] **Step 3: Push data branch**

```bash
git push origin data
```

- [ ] **Step 4: Switch back to main**

```bash
git checkout main
```

---

### Task 6: Final Verification and Cleanup

- [ ] **Step 1: Verify TypeScript on main branch**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 2: Verify lint**

```bash
npm run lint
```
Expected: No errors

- [ ] **Step 3: Verify build**

```bash
npm run build
```
Expected: Build succeeds

- [ ] **Step 4: Update README**

Update `README.md` to reflect the new architecture:
- Mention the split architecture
- Explain that data is pre-collected via ETL
- Remove references to GitHub token setup
- Add instructions for deploying to Vercel

- [ ] **Step 5: Final commit**

```bash
git add README.md
git commit -m "docs: update README for split architecture"
```

---

## Post-Implementation Checklist

- [ ] Verify `data` branch exists and has ETL workflow
- [ ] Manually trigger ETL workflow (`workflow_dispatch`) to populate initial data
- [ ] Deploy `main` branch to Vercel
- [ ] Verify dashboard loads data from `data` branch
- [ ] Confirm no GitHub API calls from browser (check Network tab)
- [ ] Confirm no localStorage usage for data caching
