---
title: feat: Add overview timeseries dashboard
type: feat
status: active
date: 2026-04-18
origin: docs/brainstorms/2026-04-18-overview-timeseries-dashboard-requirements.md
---

# feat: Add overview timeseries dashboard

## Overview

Add a new homepage aggregation layer that compares tracked repositories over a selectable time range and shows daily trends for the selected repository. The implementation should reuse the existing PR metrics dataset, keep the first release intentionally narrow, and preserve the current PR detail drill-down behavior (see origin: `docs/brainstorms/2026-04-18-overview-timeseries-dashboard-requirements.md`).

## Problem Frame

The current homepage is centered on one repository and one PR at a time. That makes it hard to answer the new issue's core questions: which repository is slower right now, whether CI E2E is staying under the 60-minute target, and whether the bottleneck is shifting over time. The new work introduces a repository-level overview table plus a per-repo daily trend chart without expanding into the deferred multi-repo comparison mode.

## Requirements Trace

- R1. Support `7 / 14 / 30 / 90` day windows plus custom date range.
- R2. Aggregate the trend chart by day only.
- R3. Show one overview row per tracked repository.
- R4. Include `PR E2E P90`, `CI E2E P90`, `PR 检视 P90`, and `CI E2E 达标率`.
- R5. Show all duration values in minutes.
- R6. Show daily trends for the selected repository.
- R7. Support the four core metrics in the chart.
- R8. Default all supported chart metrics to visible.
- R9. Use PR created-to-merged for `PR E2E`.
- R10. Use CI start-to-complete for `CI E2E`.
- R11. Use CI complete-to-merged for `PR 检视`.
- R12. Treat `CI E2E <= 60 minutes` as the SLA hit.
- R13. Provide explicit empty-state handling when metrics cannot be computed.

## Scope Boundaries

- Do not add the deferred cross-repo single-metric comparison chart in this PR.
- Do not add queue-time or workflow-runtime sublists to the homepage overview table.
- Do not alter the existing workflow/job detail behavior beyond adapting formatting where needed.
- Do not introduce a new repository-management UI; use the existing tracked repository source.

## Context & Research

### Relevant Code and Patterns

- `src/app/page.tsx` already owns homepage state, URL synchronization, time range controls, chart rendering, loading states, and empty/error handling patterns.
- `src/lib/pr-data-fetcher.ts` already loads per-repo precomputed PR index/detail JSON from `data/<owner>/<repo>/prs/...`.
- `src/lib/pr-metrics.ts` already computes the base per-PR lifecycle metrics needed for this feature: `timeToMergeInSeconds`, `ciDurationInSeconds`, and `mergeLeadTimeInSeconds`.
- `src/app/api/repos/route.ts` already exposes the set of tracked repositories by scanning `data/`, which is enough for the first overview table.
- `src/app/page.test.tsx` already uses mocked data fetchers and mocked Recharts primitives; the new UI should extend this style rather than introduce a different testing harness.

### Institutional Learnings

- None found in `docs/solutions/`.

### External References

- None. Local patterns are strong enough for this first release.

## Key Technical Decisions

- Keep aggregation on the client for v1 by fetching each repository's existing `prs/index.json` rather than adding a new pre-aggregation pipeline immediately.
  Rationale: the current repo list is small, the homepage already fetches client-side, and this avoids expanding the scope into ETL changes before the UI behavior is proven.
- Add a homepage-only aggregation layer instead of mutating the existing PR summary types into dashboard-specific shapes.
  Rationale: repository-level overview rows and daily trend points are distinct read models and should stay separate from PR-level detail records.
- Split chart units by metric family when needed rather than forcing minutes and percentage onto one misleading axis.
  Rationale: `CI E2E 达标率` is semantically different from minute-based metrics, and readability matters more than minimizing chart controls.
- Standardize homepage duration formatting to whole minutes, including existing summary cards or labels that remain visible in the redesigned layout.
  Rationale: the origin decision was explicit and applies across the homepage experience, not only the new table.

## Open Questions

### Resolved During Planning

- Should the first PR add a new precomputed aggregate file?
  Resolution: No. Use the existing per-repo PR index files for v1 and keep ETL untouched unless runtime cost proves unacceptable later.
- How should mixed chart units be handled when all metrics are visible by default?
  Resolution: Keep minute-based metrics together and render SLA rate as a separate series treatment on a percentage axis within the same chart container or a clearly adjacent paired chart, whichever is simplest to implement without misleading scaling.

### Deferred to Implementation

- Exact visual treatment for the SLA percentage line versus minute-based lines is deferred until the implementer reshapes the page layout and can see which option preserves clarity best.
- Whether to suppress P90 values for very small sample sizes is deferred to implementation, but the UI must at minimum expose a neutral empty/insufficient-data state instead of fake precision.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
tracked repos
  -> fetch each repo PR index
  -> filter PRs by selected date window
  -> derive per-repo overview metrics
  -> derive selected repo daily metric buckets
  -> render:
       1) overview table for all repos
       2) metric toggles + daily trend chart for selected repo
       3) existing PR detail section scoped to selected repo
```

## Implementation Units

- [ ] **Unit 1: Add homepage dashboard aggregation models**

**Goal:** Define the derived dashboard shapes and metric helpers needed to transform per-PR summaries into repository overview rows and daily chart points.

**Requirements:** R2, R4, R5, R7, R9, R10, R11, R12, R13

**Dependencies:** None

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/overview-metrics.ts`
- Test: `src/lib/overview-metrics.test.ts`

**Approach:**
- Introduce dashboard-specific types for repository overview rows, daily trend points, and selectable metric keys.
- Centralize common computations here: date-range filtering, minute conversion for display values, percentile calculation, SLA hit-rate calculation, and daily bucketing by PR creation date.
- Treat incomplete PR records conservatively by excluding them from metrics they cannot support while preserving enough metadata for empty-state decisions.

**Execution note:** Implement new aggregation behavior test-first.

**Patterns to follow:**
- `src/lib/pr-metrics.ts` for lifecycle metric derivation conventions
- `src/lib/collection-windows.ts` and tests for small pure-function helper style

**Test scenarios:**
- Happy path: multiple PR summaries across one repository produce correct P90 values for PR E2E, CI E2E, and PR review in minutes.
- Happy path: daily bucketing returns one point per day with all four metrics when complete data exists.
- Edge case: PRs outside the selected date window are excluded from both overview rows and trend buckets.
- Edge case: PRs missing `merged_at` or CI timestamps are excluded only from the affected metrics, not from unrelated metrics.
- Edge case: a repository with no computable samples returns an explicit empty/insufficient-data shape.
- Integration: the same filtered PR set drives both overview metrics and daily trend points so table and chart stay internally consistent.

**Verification:**
- Aggregation helpers expose deterministic outputs for overview rows and trend buckets across complete, sparse, and empty datasets.

- [ ] **Unit 2: Expand data loading from single-repo to cross-repo overview**

**Goal:** Change homepage data loading so it can populate the all-repo overview while preserving repository selection for trend and PR detail views.

**Requirements:** R1, R3, R6, R13

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/pr-data-fetcher.ts`
- Modify: `src/app/page.tsx`
- Test: `src/app/page.test.tsx`

**Approach:**
- Add a fetch path that can load PR indexes for all tracked repositories in parallel using the existing repo list from `/api/repos`.
- Keep the selected repository concept for the trend chart and existing drill-down table, but stop treating it as the only loaded dataset.
- Reuse the existing URL query state for time range and selected repo; extend the page state to store per-repo PR indexes and derived overview data.
- Keep loading and error behavior explicit when some repositories fail or return no data; avoid blocking the entire page on one repo if partial rendering is feasible with clear messaging.

**Patterns to follow:**
- `src/app/page.tsx` current `useEffect` / query-param synchronization flow
- `src/lib/pr-data-fetcher.ts` fetch wrapper style and error messaging

**Test scenarios:**
- Happy path: homepage loads two repositories and renders one overview row per repository.
- Happy path: changing the selected repo updates which repository feeds the trend chart and PR detail section.
- Edge case: preset day filters and custom date filters both recompute overview rows from the same loaded index data.
- Error path: one repository fetch failure surfaces a clear message without crashing the page shell.
- Integration: the repo selected from the overview/trend controls still drives `fetchPullRequestDetail` for PR drill-down.

**Verification:**
- Homepage state can hold multiple repository indexes while retaining a single selected repository for lower-page detail views.

- [ ] **Unit 3: Redesign homepage UI around overview table and daily trend chart**

**Goal:** Replace the single-repo-first homepage summary with the new repository overview table, metric toggles, and daily trend visualization.

**Requirements:** R1, R3, R4, R5, R6, R7, R8, R13

**Dependencies:** Unit 2

**Files:**
- Modify: `src/app/page.tsx`
- Test: `src/app/page.test.tsx`

**Approach:**
- Rework the top section so the time window controls apply globally, followed by a repository overview table that highlights the currently selected repository.
- Add chart metric toggles with all metrics enabled by default and render daily trends using the derived series from Unit 1.
- Format all homepage duration values as whole minutes and keep dark-mode-compatible Tailwind styling.
- Preserve explicit empty states for no repositories, no samples in range, and no chart data for the selected repository.
- Keep the PR detail/workflow section below the new aggregate layer so users can still drill down after spotting an outlier repository.

**Patterns to follow:**
- `src/app/page.tsx` existing loading/empty/error blocks
- Existing Tailwind table and card styling conventions in `src/app/page.tsx`

**Test scenarios:**
- Happy path: the overview table shows the four required columns with minute-based values and SLA percentage.
- Happy path: all supported trend metrics are visible by default on initial render.
- Happy path: clicking a repository row or equivalent selector changes the active repository context for the chart.
- Edge case: a repository with insufficient samples shows a neutral placeholder instead of `0` or a misleading trend line.
- Edge case: custom date ranges with no matching PRs show an explicit empty state in both table and chart regions.
- Integration: existing PR workflow expansion still works after the page is reorganized around the aggregate layer.

**Verification:**
- The homepage communicates repository comparison first, selected-repo trend second, and PR detail third, without regressing dark mode or empty-state handling.

- [ ] **Unit 4: Backfill and update test coverage for the new homepage flow**

**Goal:** Extend unit and UI tests so the aggregate dashboard behavior is covered end-to-end at the component and helper level.

**Requirements:** R1, R3, R4, R5, R6, R7, R8, R13

**Dependencies:** Units 1-3

**Files:**
- Modify: `src/app/page.test.tsx`
- Modify: `src/lib/pr-data-fetcher.test.ts`
- Modify: `src/lib/types.ts` if test fixtures depend on exported additions
- Test: `src/lib/overview-metrics.test.ts`

**Approach:**
- Update fetcher tests if new helpers are introduced for loading multiple repo indexes.
- Expand page tests to cover overview rows, chart defaults, time-range behavior, and preservation of existing drill-down behavior.
- Keep chart tests at the current mocked-Recharts level; verify data plumbing and visible labels rather than chart-library rendering internals.

**Patterns to follow:**
- `src/app/page.test.tsx` mocked navigation/fetch/data fetcher setup
- `src/lib/pr-data-fetcher.test.ts` fetch-mock based assertions

**Test scenarios:**
- Happy path: page bootstraps with multiple repositories and renders overview plus trend sections from mocked indexes.
- Happy path: toggling chart metrics hides and shows the corresponding series labels/data hooks.
- Edge case: repository data with partial metrics does not cause runtime exceptions in the UI.
- Error path: data fetch rejection produces the expected error state text.
- Integration: selecting a PR after choosing a repository still fetches detail from the correct owner/repo pair.

**Verification:**
- Automated tests cover the new aggregate view, selected-repo trend behavior, and regression-sensitive existing drill-down interactions.

## System-Wide Impact

- **Interaction graph:** Homepage state now coordinates `/api/repos`, per-repo PR index fetches, derived aggregate metrics, selected-repo chart state, and existing PR detail fetches.
- **Error propagation:** Repository index load failures should surface as explicit UI feedback; partial data should degrade gracefully instead of poisoning all derived metrics.
- **State lifecycle risks:** Derived aggregates must recompute when the date range or selected repository changes without leaving stale chart toggles or expanded PR state behind.
- **API surface parity:** No external API contract changes are planned; this is a homepage read-model expansion on top of existing JSON files.
- **Integration coverage:** The most important cross-layer behavior is that the same filtered PR dataset drives both overview rows and selected-repo trend data.
- **Unchanged invariants:** Existing PR detail JSON shape and workflow/job expansion behavior remain unchanged; the new work only changes how the homepage organizes and derives top-level data.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Client-side multi-repo fetching increases homepage load time | Keep the first release scoped to existing tracked repos and derived summaries only; revisit server/precomputed aggregation later if needed |
| Mixed minute and percentage metrics reduce chart readability | Separate metric families visually and verify the default view still reads clearly before merging |
| Sparse repository samples create misleading P90 values | Treat insufficient data as an explicit empty/neutral state rather than silently showing `0` |
| Homepage refactor regresses existing PR drill-down interactions | Preserve existing page tests and add regression coverage around detail loading and workflow expansion |

## Documentation / Operational Notes

- If the homepage layout meaningfully changes, update screenshots or descriptive copy in the PR body so reviewers can compare the new aggregate-first flow.
- No ETL or operational rollout work is planned in this first PR.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-18-overview-timeseries-dashboard-requirements.md`
- Related code: `src/app/page.tsx`
- Related code: `src/lib/pr-data-fetcher.ts`
- Related code: `src/lib/pr-metrics.ts`
- Related issue: `#16`
