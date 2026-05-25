---
title: Optimize PR Lifecycle table with stats cards and pagination
type: feat
status: completed
date: 2026-05-25
origin: user request
---

# Plan: Optimize PR Lifecycle Table with Stats Cards and Pagination

## Overview

Enhance the "PR Lifecycle" section of the dashboard with a summary statistics card, simplified table columns, and pagination. The section title is renamed to "CI Pipeline & PR Details" to reflect its broader coverage of PR, workflow, and job views.

## Problem Frame

The PR Lifecycle table had 10 columns with redundant timestamp data (T2 CI Started, T3 CI Completed duplicated information already conveyed by duration deltas). Users lacked an at-a-glance summary of CI performance for the current time window. Large PR lists had no pagination, causing long scroll.

## Requirements Trace

- R1. Section title renamed from "PR Lifecycle" to "CI Pipeline & PR Details"
- R2. Summary stats card above PR table showing: 排队时间 (avg/p50/p90), 执行时间 (avg/p50/p90), 合入时间 (avg/p50/p90), 强行合入率 (%)
- R3. Table columns simplified from 10 to 8: remove T2 CI Started, T3 CI Completed; rename remaining columns to Chinese labels
- R4. New "强行合入" column: green ✓ badge when `merged_at < ci_completed_at`
- R5. Pagination with 10/50/200 per page options (default 50)
- R6. Tooltip indicators on table headers and stats card labels explaining metric definitions
- R7. Stats computation memoized via `useMemo` to avoid redundant renders
- R8. All changes scoped to PR view mode only — workflow and job views unchanged

## Scope Boundaries

- Only the PR view within the "CI Pipeline & PR Details" section
- Stats card only renders when `prLifecycleViewMode === 'pr'` AND `filteredPrs.length > 0`
- Pagination only applies to main PR data rows — not the fallback workflow view when no PRs exist
- No backend changes — all data available from existing `PullRequestMetricsSummary` fields
- No i18n framework introduced — Chinese labels hardcoded per user request

## Context & Research

### Relevant Code and Patterns

- `src/app/DashboardClient.tsx` line 1583: Section title "PR Lifecycle"
- `src/app/DashboardClient.tsx` lines 1688-1700: PR table `<thead>` with 10 columns
- `src/app/DashboardClient.tsx` lines 1703-1724: PR table row rendering with T1-T4 timestamps
- `src/app/DashboardClient.tsx` lines 1735-1761: Expanded detail rows with `colSpan={10}`
- `src/app/DashboardClient.tsx` lines 113-144: Existing `MetricTooltip` component (reused for new tooltips)
- `src/lib/types.ts` lines 71-90: `PullRequestMetricsSummary` interface with all required fields
- `src/lib/overview-metrics.ts` lines 22-30: Existing `percentile` function pattern (reference for `computePercentile`)

### Key Technical Decisions

- **Stats card layout**: 4-card responsive grid (`grid-cols-2 md:grid-cols-4`) matching the existing PR detail card style at lines 1737-1757
- **Time metric aggregation**: avg + p50 + p90 for each of the three time metrics; single percentage for force merge rate
- **Force merge definition**: `merged_at && ci_completed_at && new Date(merged_at) < new Date(ci_completed_at)` — computed client-side from existing data
- **Stats computation**: Moved from inline IIFE to `useMemo` hook to prevent redundant `map`/`filter`/`sort` on every render
- **Percentile computation**: `computePercentile` expects pre-sorted input; `computeTimeStats` sorts once and passes sorted array (avoids double-sort)
- **Table column mapping**:
  | Before | After |
  |---|---|
  | T1 PR Created | PR提交时间 |
  | T2 CI Started | *(removed)* |
  | T3 CI Completed | *(removed)* |
  | Submit→CI Start | CI排队时间 |
  | CI Start→CI End | CI执行时间 |
  | Submit→Merge | 合入时间 (now shows `mergeLeadTimeInSeconds`) |
  | *(none)* | 强行合入 |
- **Pagination state**: `prPageSize` (10|50|200, default 50), `prPage` (default 1), auto-reset on filter/repo/date change
- **colSpan updates**: Changed from 10 to 8 in both expanded detail rows (stats cards row and workflow sub-table row)

## Open Questions

### Resolved During Planning

- **Aggregation type for time metrics?** → avg + p50 + p90 (user requested all three)
- **Force merge rate denominator?** → Only merged PRs (not open/closed PRs)
- **Table "合入时间" = Submit→Merge or CI→Merge?** → `mergeLeadTimeInSeconds` (CI complete → merge), matching the stats card definition
- **Chinese vs English labels?** → Chinese per user request, with `MetricTooltip` for definitions
- **Pagination scope?** → PR view only; workflow and job views have their own filtering

## Implementation Units

- [x] **Unit 1: Add helper functions and state**

**Goal:** Add `computePercentile`, `computeTimeStats`, pagination state, and `useMemo` for stats.

**Requirements:** R2, R5, R7

**Dependencies:** None

**Files:**
- Modify: `src/app/DashboardClient.tsx`

**Approach:**
- Add `computePercentile(sortedValues, p)` — expects pre-sorted array
- Add `computeTimeStats(values)` — sorts once, computes avg/p50/p90, returns `null` if < 2 values
- Add state: `prPageSize` (10|50|200, default 50), `prPage` (default 1)
- Add `useEffect` to reset `prPage` to 1 when `dateRangePrs.length`, `filterName`, or `selectedRepoKey` changes
- Add `paginatedPrs` useMemo: `filteredPrs.slice((prPage - 1) * prPageSize, prPage * prPageSize)`
- Add `prLifecycleStats` useMemo: computes queueStats, ciStats, mergeStats, mergedPrCount, forceMergedCount

- [x] **Unit 2: Update section title and add stats card**

**Goal:** Rename section title, insert stats card grid.

**Requirements:** R1, R2, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/app/DashboardClient.tsx`

**Approach:**
- Change `<h2>` text from "PR Lifecycle" to "CI Pipeline & PR Details"
- Update subtitle to "Drill into PR, workflow, and job details for {repo}."
- Insert stats card section between header and PR view conditional
- 4 cards in responsive grid with `MetricTooltip` on each label
- Only renders when `prLifecycleStats` is non-null

- [x] **Unit 3: Update PR table headers and rows**

**Goal:** Simplify columns, add force merge badge, add tooltips.

**Requirements:** R3, R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/app/DashboardClient.tsx`

**Approach:**
- Replace 10-column `<thead>` with 8-column version
- Add `MetricTooltip` to each header with definition text
- Update `<tbody>` rows: remove T2/T3 cells, update column order, add force merge badge
- Force merge badge: green ✓ for force-merged, "—" otherwise
- Update `colSpan` from 10 to 8 in both expanded detail rows
- Replace `filteredPrs.map(...)` with `paginatedPrs.map(...)`

- [x] **Unit 4: Add pagination controls**

**Goal:** Add page size selector and prev/next buttons.

**Requirements:** R5

**Dependencies:** Unit 3

**Files:**
- Modify: `src/app/DashboardClient.tsx`

**Approach:**
- Add pagination div below `</table>` (inside PR view, after main table)
- Only renders when `filteredPrs.length > prPageSize`
- "Showing X–Y of Z" counter on left
- Previous button (disabled on page 1), page size dropdown (10/50/200), Next button (disabled on last page)

- [x] **Unit 5: Update tests**

**Goal:** Fix test assertion for new "Insufficient data" count.

**Requirements:** R8

**Dependencies:** All units

**Files:**
- Modify: `src/app/page.test.tsx`

**Approach:**
- Update `findAllByText('Insufficient data')` count from 8 to 12 (4 new stats cards each show "Insufficient data" in empty state)

## System-Wide Impact

- **Unchanged invariants:** `PullRequestMetricsSummary` interface unchanged — all fields already exist. No data fetching changes.
- **Interaction graph:** No new API calls. Stats computed from existing `filteredPrs` array.
- **API surface parity:** None — pure client-side rendering change.
- **Performance:** `useMemo` ensures stats computation only runs when `filteredPrs` or view mode changes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `mergeLeadTimeInSeconds` may be undefined for many PRs | Stats card shows "Insufficient data" when < 2 values; table cell shows "N/A" |
| Pagination resets unexpectedly | `useEffect` resets only on explicit triggers (repo change, filter change, date range change) |
| colSpan mismatch after column removal | Verified: 8 columns in header → `colSpan={8}` in expanded rows |

## Review Feedback

| # | Reviewer | Feedback | Action |
|---|---|---|---|
| 1 | Gemini | `computePercentile` double-sorts | ✅ Adopted: sort once in `computeTimeStats` |
| 2 | Gemini | Stats in IIFE re-renders every time | ✅ Adopted: moved to `useMemo` |
| 3 | Gemini | Chinese labels inconsistent with English UI | ❌ Skipped: user explicitly requested Chinese |
| 4 | Gemini | "合入时间" label ambiguous | ⚠️ Addressed: added `MetricTooltip` with definition |

## Sources & References

- **Origin:** User request for PR Lifecycle table optimization
- Related code: `src/app/DashboardClient.tsx`, `src/lib/types.ts`, `src/lib/overview-metrics.ts`
- Related test: `src/app/page.test.tsx`
- PR: https://github.com/pkking/action-insight/pull/93
