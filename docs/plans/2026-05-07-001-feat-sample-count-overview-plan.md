---
title: Show sample counts in overview table metrics
type: feat
status: completed
date: 2026-05-07
origin: docs/brainstorms/2026-05-07-metric-confidence-signals-requirements.md
---

# Plan: Show Sample Counts in Overview Table Metrics

## Overview

Display `(n=X)` sample counts alongside each metric value in the Repository Overview table, with amber styling when `n < 5`. The `sampleCount` field already exists in `RepoOverviewRow` and is computed server-side — this is purely a UI rendering change.

## Problem Frame

Users see P90 metrics like "45m" with no indication of data quality. A metric based on 2 PRs looks identical to one based on 200 PRs. The `sampleCount` is computed but never rendered. (see origin: docs/brainstorms/2026-05-07-metric-confidence-signals-requirements.md)

## Requirements Trace

- R1. Every metric cell in the overview table shows `(n=X)` when sampleCount > 0
- R2. Low sample counts (n < 5) are visually distinguishable via amber color
- R3. No new API calls or data fetching required
- R4. Existing tests continue to pass
- R5. Dark mode styling matches light mode semantics

## Scope Boundaries

- Only the Repository Overview table — not PR Lifecycle table or daily trend chart
- Hardcoded `n < 5` threshold — no config system for v1
- No confidence badges — just the `(n=X)` suffix with conditional color

## Context & Research

### Relevant Code and Patterns

- `src/app/DashboardClient.tsx` lines 847-850: Overview table metric cells render via `formatMetricMinutes(row.prE2EP90Minutes)` etc.
- `src/app/DashboardClient.tsx` lines 92-97: `formatMetricMinutes` and `formatRate` helper functions
- `src/lib/types.ts` lines 116-124: `RepoOverviewRow` interface already has `sampleCount: number`
- `src/lib/overview-metrics.ts` lines 94-109: `buildRepoOverviewRows` already computes `sampleCount: filtered.length`
- `src/app/page.test.tsx` line 443: Existing test asserts "Insufficient data" appears 8 times — will need update after this change

### Key Technical Decisions

- **Inline suffix vs. helper component**: Use inline JSX within each `<td>` — the change is small enough that a separate component would be over-engineering. Wrap the metric value and `(n=X)` in a `<>` fragment inside each cell.
- **Threshold constant**: Define `const LOW_SAMPLE_THRESHOLD = 5` at the top of `DashboardClient.tsx` near the other constants (METRIC_OPTIONS) rather than hardcoding the magic number in JSX.

## Open Questions

### Resolved During Planning

- Where to place the threshold constant? → With other module-level constants in `DashboardClient.tsx`
- Should "Insufficient data" cells also show `(n=0)`? → No — the requirements specify no change for the n=0 case

## Implementation Units

- [x] **Unit 1: Add sample count suffix to overview table metric cells**

**Goal:** Render `(n=X)` next to each metric value in the Repository Overview table.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/app/DashboardClient.tsx`

**Approach:**
- Add `const LOW_SAMPLE_THRESHOLD = 5` near the module-level constants
- Replace each of the 4 metric `<td>` cells (lines 847-850) with a fragment containing the formatted value and the `(n={row.sampleCount})` suffix
- The suffix uses `text-xs` for smaller font size
- When `row.sampleCount < LOW_SAMPLE_THRESHOLD`, apply `text-amber-600 dark:text-amber-400` to the suffix
- When `row.sampleCount >= LOW_SAMPLE_THRESHOLD`, the suffix inherits the parent's text color

**Patterns to follow:**
- Existing dark mode patterns in `DashboardClient.tsx` (e.g., line 172: `dark:border-green-800/50 dark:bg-green-900/30 dark:text-green-400`)
- The `text-xs` utility already used for secondary text (line 844: `{row.totalPrs} PRs in range`)

**Test scenarios:**
- Happy path: Overview table renders with `(n=X)` suffix for each metric when sampleCount > 0
- Edge case: When sampleCount = 0, metric shows "Insufficient data" without suffix (existing behavior preserved)
- Edge case: When sampleCount = 4, suffix renders with amber color classes
- Edge case: When sampleCount = 5, suffix renders with normal text color

**Verification:**
- Overview table shows `(n=X)` for all metric cells with data
- Low sample counts (n < 5) have amber-colored suffix in both light and dark mode

- [x] **Unit 2: Update existing tests for new metric format**

**Goal:** Ensure existing tests pass with the new `(n=X)` suffix format.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/app/page.test.tsx`

**Approach:**
- The test at line 443 asserts `findAllByText('Insufficient data')` returns 8 elements — this should still pass since "Insufficient data" is unchanged for n=0 cases
- Add a new test case that verifies `(n=X)` appears in metric cells when sampleCount > 0
- The existing mock data in `page.test.tsx` uses `sampleCount` implicitly via `buildRepoOverviewRows` — verify the test fixtures produce rows with sampleCount > 0

**Test scenarios:**
- Happy path: Test confirms `(n=` text appears in overview table when repos have PR data
- Integration: Existing "Insufficient data" test continues to pass (8 elements)

**Verification:**
- `npm test` passes with no failures

## System-Wide Impact

- **Unchanged invariants:** `formatMetricMinutes` and `formatRate` functions remain unchanged — they still return the same values. The suffix is added at the render layer only.
- **Interaction graph:** No callbacks, middleware, or observers affected. Pure UI rendering change.
- **API surface parity:** None — this is client-side rendering only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Table column width increases on narrow screens | Table is already in `overflow-x-auto` container; suffix uses `text-xs` |
| Test fixtures may not have sampleCount > 0 | Verify mock data; add explicit sampleCount if needed |

## Sources & References

- **Origin document:** docs/brainstorms/2026-05-07-metric-confidence-signals-requirements.md
- Related code: `src/app/DashboardClient.tsx` (lines 847-850), `src/lib/types.ts` (lines 116-124)
- Related test: `src/app/page.test.tsx` (line 443)
