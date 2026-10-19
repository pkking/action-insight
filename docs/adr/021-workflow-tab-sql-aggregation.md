# ADR-021: SQL-side aggregation for the Workflow tab read model

**Status**: Accepted

## Context

The Workflow tab's grouped table (one row per repo / workflow file / ref /
resource model) was built by `fetchCostJobRows`, which transferred **every
`workflow_jobs` row in the window** to Node and aggregated in JS. For the
default 14-day all-repo window that is ~590K rows (and growing with
collection): ~1.0s of pg-driver transfer, ~0.1s of row mapping, and ~0.3s of
JS grouping — roughly 1.4s of the tab's ~1.7s server time. Profiling
confirmed the SQL join itself is fast (~80ms for a count); the cost is row
materialization and client-side aggregation.

## Decision

1. **Push the grouping into SQL** (`fetchWorkflowGroupRows`): a two-stage
   hash aggregation — job rows → per-(group, attempt) via `GROUP BY`, then
   per-group rollup — returns one `WorkflowGroupRow` per group (~51 rows for
   the default window) instead of 590K raw rows. Attempt-level stats
   (count / success / terminal / avg total duration) are computed over
   distinct (run_id, run_attempt) pairs, so a many-job attempt is not
   weighted by its job count. `COUNT(DISTINCT)` variants were measured
   slower (2.0s) than the two-stage GROUP BY because PostgreSQL cannot
   share distinct state across `FILTER` clauses.
2. **Transaction-scoped `work_mem`**: the distinct-attempt rollup spilled a
   ~2.8MB external-merge sort at the default 4MB `work_mem`. The fetcher
   wraps its single query in `BEGIN; SET LOCAL work_mem = '64MB'; COMMIT`
   so the bump applies only to this query and never leaks to pooled
   connections. This cut the query from ~820ms to ~500ms.
3. **Builder contract change**: `buildWorkflowCards` and
   `buildWorkflowDashboardResult` now accept pre-aggregated
   `WorkflowGroupRow[]` (SQL grain) instead of raw `CostJobRow[]`. The
   WorkflowGroup JS type is removed. Table semantics — group keys,
   machine-hours basis (ADR-018), failure rate over terminal attempts,
   sort order, observation cap, pagination — are unchanged.
4. **Unknown-cost accounting is NULL-safe**: a job counts as unknown-cost
   when runtime IS NULL / < 0 OR resource count IS NULL / <= 0. A naive
   `NOT (rt >= 0 AND rc > 0)` silently drops NULL rows (three-valued
   logic) and understates the unknown count — caught by the parity check.

## Verification constraints

Any change to group semantics must keep old/new parity: the live-data
parity harness compares the previous JS aggregation against the SQL output
row by row (51/51 groups identical at acceptance, including unknown-cost
counts and per-attempt averages).

## Trade-offs and scope

- The SQL aggregation is ~0.5s for the default window on the current
  Docker-backed Postgres — the remaining floor is the join + hash work
  over 590K rows, not transfer. Further gains need pre-aggregated
  tables/materialized views, which are out of scope.
- The Job, Queue, Cost, and PR tabs still transfer full window job rows
  (`fetchJobRows`, `fetchCostJobRows`, `fetchPrJobTimeline`) and remain the
  slowest tabs (~2s). They can adopt the same pattern in follow-ups; this
  ADR only changes the Workflow tab path. `fetchCostJobRows` is retained
  for the Cost tab.
- Live aggregation keeps freshness exact (no cache invalidation); a
  materialized rollup would trade that for speed.
