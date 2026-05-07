---
date: 2026-05-07
topic: open
---

# Ideation: Action Insight Improvements (Refreshed)

## Codebase Context

- **Project shape**: Next.js 16 + React 19 + TypeScript frontend with split architecture. `page.tsx` is a thin server component (22 lines), while `DashboardClient.tsx` (~1100 lines) handles all interactive UI, state, chart rendering, and data fetching on the client.
- **Data layer**: `data-fetcher.ts` (workflow runs) and `pr-data-fetcher.ts` (PR indexes) both fetch from `raw.githubusercontent.com`. `server-homepage-data.ts` reads PR indexes server-side from local `data/` directory.
- **ETL pipeline**: `collect.ts` (753 lines) with rate limiting, retry logic, PR artifact resolution (SHA-to-PR mapping with search fallback), backfill cursor, and window splitting. `pr-artifacts.ts` handles PR index/detail generation.
- **Metrics**: `overview-metrics.ts` computes P90 metrics and SLA rates client-side. `pr-metrics.ts` derives PR summaries from runs + snapshots. `time-utils.ts` (added recently) handles duration math with negative clamping.
- **Tracked repos**: 5 repos in `etl/repos.yaml` (vllm-ascend, sglang, tilelang-ascend, verl, triton-ascend). `tracked-repos.js` is JSDoc while the rest of codebase is TypeScript.
- **Tests**: Coverage exists for data-fetcher, overview-metrics, pr-metrics, collection-windows, collect, collect-options.
- **What changed since April 19**: `page.tsx` cleaned to thin server component; PR metrics derivation fixed (#57) via new `time-utils.ts`; ETL gained robust rate limit budget checking; `pr-artifacts.ts` added SHA resolution with configurable limits.

## Ranked Ideas (Stricter Pass — 3 Survivors)

### 1. Metric Confidence Signals with Sample Context
**Description:** Display `sampleCount`, time range coverage, and confidence states (green/yellow/red) next to each metric. The `RepoOverviewRow` type already carries `sampleCount` — it's just never rendered.
**Rationale:** Users can't act on "P90: 45m" without knowing if it's 2 samples or 200. Current "Insufficient data" is binary and unhelpful. Lowest effort survivor with highest trust impact.
**Downsides:** Minor UI clutter; needs design restraint.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 2. SLO Compliance Dashboard
**Description:** Add configurable SLO thresholds per metric (e.g., "CI E2E < 60min", "Queue < 15min") and show compliance scoring per repo. Extend existing `ciE2ESlaRate` logic into a general framework.
**Rationale:** The `toRateOrNull` function already hardcodes a 1hr SLA check. Generalizing this into explicit, configurable thresholds turns abstract P90 numbers into team commitments.
**Downsides:** Requires per-repo config; arbitrary thresholds may create noise.
**Confidence:** 84%
**Complexity:** Low-Medium
**Status:** Unexplored

### 3. Job-level Analytics Dashboard
**Description:** New `/jobs` route showing queue time distributions, job duration patterns, failure rates by job name, and runner utilization. Aggregates from existing job data in daily files.
**Rationale:** ETL already collects `queueDurationInSeconds` and `durationInSeconds` per job. This data is buried in per-workflow drill-down. Surfacing it unlocks capacity planning and bottleneck identification.
**Downsides:** New page needed; aggregation of large job datasets may be slow client-side.
**Confidence:** 81%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Component Extraction with Error Boundaries | Duplicates April #2 "Split homepage monolith" |
| 2 | TypeScript Migration for tracked-repos | Trivial chore, not strategic improvement |
| 3 | Smart Date Range Picker | Already has presets (7/14/30/90) + custom; UX polish only |
| 4 | Auto-Repo Discovery from GitHub Org | Not grounded — no org API integration exists |
| 5 | Event-Driven ETL via Webhooks | Too expensive — requires webhook infra, major architecture change |
| 6 | Lazy PR Index Loading by View Mode | Already partially addressed by server-side loading |
| 7 | Self-Regulating Rate Limit Budget | Current handling already robust with retry + budget checks |
| 8 | GitHub API Collection Window Delegation | Not actionable — GitHub API doesn't support needed backfill logic |
| 9 | Pre-Fetch PR Metrics During ETL | Already done — `rebuildPullRequestArtifacts` runs during ETL |
| 10 | Real-Time Failure Detection via Webhooks | Same as #5 — too expensive |
| 11 | Team Workspace Mode | Not grounded — no auth, user model, or persistence layer |
| 12 | Failure Pattern Classifier (ML) | Too speculative — no ML infrastructure or error signatures |
| 13 | Workflow Dependency Graph | Not grounded — workflow_call relationships not in data model |
| 14 | Publish collection-windows as NPM | Too expensive — maintaining package for internal use |
| 15 | GraphQL Layer | Over-abstract for current project size |
| 16 | Split Architecture Template Repo | Not a product improvement for Action Insight itself |
| 17 | Add more chart types for overview | Duplicates active overview-timeseries work |
| 18 | Real-time auto-refresh polling | Expensive relative to value given offline/cache-first design |
| 19 | Slack alert integration for failing workflows | Not grounded in current repo's capabilities |
| 20 | Multi-repo side-by-side trend overlays | Already deferred by current overview docs; covered by #4 |
| 21 | AI-generated remediation suggestions | Too speculative |
| 22 | Per-job flamegraph visualization | Lower leverage than explaining bottlenecks |
| 23 | Cross-repo anomaly detection | Too expensive before trust metadata exists |
| 24 | User auth and personalized dashboards | Major product expansion, not grounded |
| 25 | Export to CSV / PNG | Actionable but weaker than structural improvements |
| 26 | Inline workflow log previews | Secondary to structural leverage points |
| 27 | Configurable SLA thresholds per repo | Covered by #3 SLO Compliance Dashboard |
| 28 | ETL-side pre-aggregated homepage files | Premature optimization |
| 29 | Advanced statistical percentiles beyond P90 | Too vague in user value |
| 30 | Dedicated mobile layout redesign | Worth doing eventually, not strongest leverage |
| 31 | Local cache of PR detail in IndexedDB | Too implementation-shaped, low visible value |
| 32 | Repo grouping by org/team heatmap | Depends on #5 repo categorization; weaker than establishing that first |
| 33 | Add CI cost estimation in dollars | Not grounded in existing data model |
| 34 | Full plugin system for custom metrics | Over-abstract for current project size |
| 35 | ETL Collection Health Dashboard | High implementation burden; overlaps with #1 (confidence signals could surface staleness) |
| 36 | Cross-Repo Trend Comparison | Requires reworking trend data model; better as brainstorm variant |
| 37 | Repo Categorization & Filtering | Solves hypothetical scale problem (5 repos today) |
| 38 | Workflow Health Heatmaps | New viz library needed; Recharts heatmap support is weak |

## Session Log

- 2026-04-19: Initial ideation — 24 candidates generated, 6 survived.
- 2026-05-07: Refreshed ideation — 40 raw candidates across 4 frames (user pain, inversion/removal, assumption-breaking, leverage), ~25 after dedupe, 7 survived. Key changes since April: `page.tsx` split to thin server component, PR metrics derivation fixed (#57), ETL gained rate limit budget checking. New angles: ETL health visibility, heatmap visualization, job-level analytics, SLO compliance.
- 2026-05-07: Stricter pass — raised bar on groundedness, value density, independence, and novelty. 7 → 3 survivors. Cut: ETL health dashboard (high burden, overlaps with #1), cross-repo comparison (data model rework needed), repo categorization (hypothetical scale problem), heatmaps (weak Recharts support).
