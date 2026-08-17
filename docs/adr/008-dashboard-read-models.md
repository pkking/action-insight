# ADR-008: Server-side dashboard read models over attempt-scoped data

**Status**: Implemented (five-tab dashboard shipped; superseded client homepage paths removed in the closeout)
**Date**: 2026-08-15
**Context**: Production implementation of the approved five-tab dashboard prototype

## Decision

The production dashboard will use server-side, tab-specific read models derived from the existing PostgreSQL attempt-scoped tables. Workflow, job, queue, and machine-hour metrics use `workflow_attempts`, `workflow_jobs`, and their repository/run metadata; PR drill-down uses `pr_metrics` and `pr_workflow_attempts`. Legacy `runs`, `jobs`, and `pr_workflows` remain compatibility fallbacks, not the primary dashboard source.

Each tab query returns one coherent result containing metric cards, daily series, a paged detail summary, sample/data-quality counts, and truncation metadata. Filters are applied in SQL before aggregation. Detail observations are ordered newest first and limited to 500 after filtering; aggregate cards and total counts continue to describe the full filtered population. Drill-down rows are fetched only when opened and are bounded separately.

Machine-Hours are derived at read time as `Job Runtime × Resource Count ÷ 3600`. Queue duration is excluded. Samples without a positive Resource Count or valid Job Runtime are excluded from Machine-Hour totals and reported as unknown-cost samples rather than treated as zero.

Version 1 will not add dashboard aggregate tables, materialized views, or GitHub API calls. Existing React/server caching and PostgreSQL remain the reuse points. Add query indexes only when `EXPLAIN` or measured production latency demonstrates a need; introduce pre-aggregation only if the direct read model cannot meet the agreed latency target under retained data volume.

## Rationale

The required raw fields and attempt identities already exist following ADR-005. Server-side aggregation avoids sending all retained workflow/job records to the browser, keeps metric definitions in one testable module, and does not spend GitHub API quota. A coherent per-tab result prevents cards, charts, and tables from silently using different filters or definitions.

A 500-observation display cap bounds browser and chart work without corrupting full-range aggregates. Lazy drill-down avoids loading steps and job detail for rows the user never opens. Deferring pre-aggregation is the smallest reversible choice while the query shape and usage volume are still being validated.

## Consequences

### Positive
- No new collection path or GitHub API cost.
- Attempt reruns remain distinct in workflow, job, queue, and cost analysis.
- Metric definitions and data-quality exclusions are centralized and testable.
- Initial rollout can reuse current tables and caching.
- Browser payload and chart rendering are bounded.

### Negative
- Direct aggregate queries add PostgreSQL work on cache misses.
- Cards may cover more samples than the capped chart/table; the UI must show both full totals and the displayed-observation count.
- Compatibility fallback data may lack attempt/resource fidelity and must be labeled partial rather than merged invisibly.
- Step drill-down remains incomplete by design because only Eligible Step Data is persisted.

## Alternatives Considered

1. **Aggregate in `DashboardClient.tsx` from all raw records** — rejected because payload size and duplicated metric logic grow with retention volume.
2. **Create aggregate tables/materialized views immediately** — rejected because refresh policy, migrations, and operational cost are premature before query latency is measured.
3. **Extend ETL to emit dashboard-specific artifacts** — rejected because it duplicates PostgreSQL as a source of truth and couples presentation changes to collection.
4. **Cap the source population before computing cards** — rejected because metrics would change when display limits change and would undercount the selected range.
5. **Treat missing Resource Count as one** — rejected because it fabricates Machine-Hours; unknown cost must remain visible as a data-quality gap.
