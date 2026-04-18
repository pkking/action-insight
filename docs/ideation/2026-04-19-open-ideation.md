---
date: 2026-04-19
topic: open
---

# Ideation: Action Insight Improvements

## Codebase Context

- Project shape: Next.js 16 + React 19 + TypeScript frontend with a split data model. `src/app/page.tsx` is the main interactive dashboard entrypoint, while `src/lib/*` holds fetchers, PR metric derivation, and overview aggregation helpers.
- Current leverage points: the repo already has PR-level summary data, repo discovery, overview metrics, and dashboard tests. That means the fastest meaningful improvements are ones that reuse these primitives instead of expanding ETL scope immediately.
- Obvious pain points: `src/app/page.tsx` owns too much UI and state orchestration, repo discovery is purely filesystem-driven, data access is split across `data-fetcher.ts` and `pr-data-fetcher.ts`, and metric outputs still have weak trust signals around partial history / sample quality.
- Existing direction: recent brainstorm and plan docs already cover the new overview + timeseries dashboard, so new ideas should avoid duplicating that exact initiative.
- Past learnings: none found in `docs/solutions/`.

## Ranked Ideas

### 1. Add a metric trust layer with sample-size and partial-history warnings
**Description:** Introduce explicit reliability metadata for every repo-level and daily metric point, including sample count thresholds, partial-history coverage, and "insufficient / low-confidence / healthy" states.
**Rationale:** The current dashboard already computes metrics from incomplete PR histories and shows generic "Insufficient data" fallbacks. A trust layer would make the numbers safer to act on and directly addresses the repo's CI-observability purpose.
**Downsides:** Requires UI changes across tables and charts, plus design work to avoid cluttering the dashboard.
**Confidence:** 91%
**Complexity:** Medium
**Status:** Unexplored

### 2. Split the homepage monolith into dashboard sections and hooks
**Description:** Refactor `src/app/page.tsx` into smaller client components and focused hooks for URL state, repo loading, metric selection, PR detail loading, and workflow/job expansion.
**Rationale:** The current page mixes routing, aggregation, charts, tables, and workflow drill-down in one large client component. This is the strongest maintainability bottleneck and will slow every future feature.
**Downsides:** Mostly an internal win unless paired with follow-on features; refactors can create churn if done without clear seams.
**Confidence:** 89%
**Complexity:** Medium
**Status:** Unexplored

### 3. Build a derived "CI bottleneck explainer" view
**Description:** Add a view that classifies slow PRs into queue delay, CI runtime, review lag, or mixed causes, then ranks repositories by their dominant bottleneck.
**Rationale:** The repo already computes `timeToCiStart`, `ciDuration`, and `mergeLeadTime`; turning those into explanation categories would help users answer "why is this repo slow?" instead of just "which repo is slow?"
**Downsides:** Needs careful heuristics and may tempt scope creep into root-cause analysis before the classification rules are trustworthy.
**Confidence:** 84%
**Complexity:** Medium
**Status:** Unexplored

### 4. Unify run-level and PR-level data access behind one repository data service
**Description:** Replace the parallel `data-fetcher.ts` and `pr-data-fetcher.ts` split with a shared data-access layer that exposes consistent repo, date-range, and error-handling semantics.
**Rationale:** The codebase currently has two fetch paths with overlapping concerns and different data shapes. A unified data service would reduce duplicated branching and make future dashboard slices easier to add.
**Downsides:** Architectural work can get abstract if it is not tied to a concrete next feature.
**Confidence:** 82%
**Complexity:** Medium
**Status:** Unexplored

### 5. Add repository catalog metadata instead of raw directory scanning
**Description:** Move from "every directory under `data/` is a selectable repo" to an explicit tracked-repo catalog with labels, display names, tags, default filters, and hidden/test repo controls.
**Rationale:** `/api/repos` currently exposes everything it sees on disk, including obvious test fixtures like `boundary-retention-test`. A catalog would improve UX immediately and create a better base for repo grouping and filtering.
**Downsides:** Needs one more source of truth to maintain and some migration logic for existing repo discovery.
**Confidence:** 87%
**Complexity:** Medium
**Status:** Unexplored

### 6. Add saved investigation states via URL presets
**Description:** Let users persist metric toggles, time windows, repo selection, and view mode as named presets or fully shareable URLs.
**Rationale:** The page already syncs part of its state to query params. Extending that into intentional investigation presets would turn the dashboard from a transient viewer into a reusable operational tool.
**Downsides:** UX value is real but secondary if core data trust and information architecture are still weak.
**Confidence:** 78%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Add more chart types for the new overview dashboard | Duplicates the active overview-timeseries work and is too close to already-documented scope. |
| 2 | Real-time auto-refresh polling | Likely expensive relative to value given the repo's offline/cache-first design. |
| 3 | Slack alert integration for failing workflows | Interesting but not grounded in the current repo's existing capabilities or local code seams. |
| 4 | Multi-repo side-by-side trend overlays | Already deferred by the current overview dashboard docs; better as a later brainstorm variant. |
| 5 | AI-generated remediation suggestions for failures | Too speculative and not justified by the present codebase. |
| 6 | Per-job flamegraph visualization | Visually interesting, but lower leverage than explaining bottlenecks and data trust first. |
| 7 | Cross-repo anomaly detection | Valuable eventually, but too expensive before trust metadata and clearer aggregate semantics exist. |
| 8 | User auth and personalized dashboards | Not grounded in current architecture; major product expansion. |
| 9 | Export to CSV / PNG | Actionable but weaker than improving trust, maintainability, and repo selection foundations. |
| 10 | Inline workflow log previews | Useful, but secondary to more structural leverage points. |
| 11 | Configurable SLA thresholds per repo | Strong follow-on to metric trust, but weaker as a first move without a repo catalog. |
| 12 | ETL-side pre-aggregated homepage files | Premature optimization given current docs explicitly favor frontend aggregation first. |
| 13 | Advanced statistical percentiles beyond P90 | Too vague in user value and not tied to a concrete pain observed in the current repo. |
| 14 | Dedicated mobile layout redesign | Worth doing eventually, but not among the strongest leverage points from this scan. |
| 15 | Local cache of fetched PR detail in IndexedDB | Too implementation-shaped and low-value compared with more visible product wins. |
| 16 | Repo grouping by org/team heatmap | Depends on explicit repo catalog metadata; weaker than establishing that foundation first. |
| 17 | Add CI cost estimation in dollars | Not grounded in existing data model. |
| 18 | Full plugin system for custom metrics | Over-abstract and too expensive for the current project size. |

## Session Log

- 2026-04-19: Initial ideation — 24 candidates generated, 6 survived.
