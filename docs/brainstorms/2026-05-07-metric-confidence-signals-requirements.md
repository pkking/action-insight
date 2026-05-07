---
date: 2026-05-07
topic: metric-confidence-signals
---

# Requirements: Metric Confidence Signals (v1 — Sample Count)

## Problem

Users see P90 metrics (e.g., "P90: 45m") in the overview table with no indication of data quality. A metric based on 2 PRs looks identical to one based on 200 PRs. The only existing trust signal is "Insufficient data" — a binary fallback that provides no granularity.

The `sampleCount` field already exists in `RepoOverviewRow` and `DailyTrendPoint` types but is never rendered in the UI.

## Goal

Show sample counts alongside metric values in the overview table so users can judge metric reliability at a glance.

## Scope

### In Scope
- Display `(n=X)` next to each metric value in the **Repository Overview** table
- Apply subtle amber styling when `n < 5` to signal low sample size
- No new data fetching — `sampleCount` is already computed server-side

### Out of Scope
- Confidence badges (🟢/🟡/🔴) — deferred to future iteration
- Daily trend chart tooltip updates — lower priority, can follow
- Configurable thresholds — hardcoded `n < 5` for v1
- PR Lifecycle table — only the overview table for v1

## User Behavior

### Current
1. User opens dashboard
2. Sees overview table with metrics like "45m", "12m", "Insufficient data"
3. Cannot tell if "45m" is based on 2 samples or 200
4. Must mentally guess whether to trust the number

### After
1. User opens dashboard
2. Sees overview table with metrics like "45m (n=23)", "12m (n=3)"
3. Amber-colored count when n < 5 signals caution
4. Can immediately judge whether a metric is reliable

## UI Specification

### Overview Table Metric Cells

**Format:** `{metricValue} (n={sampleCount})`

**Examples:**
- `45m (n=23)` — healthy sample count, normal text color
- `12m (n=3)` — low sample count, amber text on the `(n=3)` portion
- `Insufficient data` — no change (n=0 case, already handled)
- `85% (n=18)` — SLA rate with sample count

**Styling:**
- The `(n=X)` suffix uses `text-xs` (one size smaller than the metric value)
- When `sampleCount < 5`: the `(n=X)` portion renders in `text-amber-600 dark:text-amber-400`
- When `sampleCount >= 5`: the `(n=X)` portion inherits the parent text color (`text-neutral-700 dark:text-neutral-300`)

### Placement

Only the **Repository Overview** table (the first section on the dashboard). The PR Lifecycle table and daily trend chart are unchanged in v1.

## Success Criteria

- [ ] Every metric cell in the overview table shows `(n=X)` when sampleCount > 0
- [ ] Low sample counts (n < 5) are visually distinguishable via amber color
- [ ] No new API calls or data fetching required
- [ ] Existing tests continue to pass
- [ ] Dark mode styling matches light mode semantics

## Dependencies

None. All required data (`sampleCount`) is already present in `RepoOverviewRow` and computed in `overview-metrics.ts`.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Table column width increases | Use `text-xs` for suffix; table is already horizontally scrollable |
| Users misinterpret n=3 as "bad" | Amber is a caution signal, not an error — consistent with existing warning patterns |
| Future threshold changes needed | Hardcoded `n < 5` is easy to extract to config later |
