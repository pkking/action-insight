# ADR-020: PR-level CI cycles and conclusion-split card-hours

**Status**: Accepted

## Context

The PR drill-down previously surfaced a single CI runtime per PR — the
`pr_metrics.ci_duration_seconds` envelope (earliest linked run created →
latest linked run completed). Two problems surfaced with
`sgl-project/sglang` PR #41907:

1. **Envelope blindness.** One cancelled `pr-test.yml` run whose GB300
   jobs hung for exactly 24h/48h on lost self-hosted runners stretched the
   envelope to 50.7h, while the user-perceived wait per push was a median
   ~3h across 13 push cycles. A single envelope cannot distinguish "one
   long cycle" from "many short cycles plus one hang", and it hides
   iteration cost (13 pushes over 15 days).
2. **Partial attribution.** `pr_workflow_attempts` linking depends on
   SHA→PR resolution, which is budget-capped per rebuild round. PR #41907
   had only 2 of 26 runs linked, so the drill-down showed 1 cycle instead
   of 13, and card-hours were understated.
3. **Card-hours had no total or outcome split.** The drill-down showed
   per-resource-model machine-hour chips but no PR-level total, no
   success/failure/cancelled split, and no visibility into jobs without
   resource attribution (e.g., GPU runners whose labels are not mapped to
   `resource_model`).

## Decision

1. **CI cycles (per push batch).** Runs are grouped into cycles by
   `(head_sha, run created_at)` — every run triggered by one push event
   carries the identical pair, so grouping never relies on loose time
   proximity. Cycle wall time = earliest run `created_at` → latest run
   `completed_at` (queue included), i.e., the user-perceived wait for that
   push. The drill-down shows cycle count, median/p90/max wall, per-cycle
   rows with workflow conclusions, and an "outlier" marker when a closed
   cycle exceeds 2× the median (≥3 cycles). Cycles missing an end
   timestamp are reported as open, never clamped.
2. **Branch-matched read-time enrichment.** `fetchPullRequestDetail`
   additionally selects tracked pull-request-event attempts on the PR's
   branch, bounded by the PR lifecycle (`PR created_at` → `merged_at`, or
   now), repo-scoped, capped at 500 attempts. Linked `pr_workflow_attempts`
   rows always win; recovered runs are tagged `branchMatched` and
   disclosed in the UI. This is a read-model-only recovery — no ETL or
   storage change — and does not repair `pr_metrics` aggregates.
3. **Card-hours totals follow ADR-018.** PR card-hours = Σ Job Runtime ×
   Resource Count ÷ 3600 over attributed jobs, split by conclusion
   (success / failure / cancelled / other). Cancelled consumption stays in
   totals — a cancelled job may still have occupied cards, and runner-lost
   hangs remain auditable in the cancelled bucket. Unknown-cost jobs
   (model known, count/timing missing) and unattributed jobs (no
   `resource_model`) are counted, never zero-filled.

## Trade-offs

- Branch matching accepts a small mis-attribution risk when a branch name
  is reused across PRs within one lifecycle window; the window bound and
  the UI disclosure (`*`/run counts) keep it visible. Attribution quality
  improves automatically as rebuild rounds deepen `pr_workflow_attempts`.
- Cycle wall includes cancelled-lag (time until someone cancelled a hung
   run) by design: that is what the PR author actually waited. The outlier
   marker plus conclusion chips separate hangs from normal cycles instead
   of hiding them.
- `ci_duration_seconds` (envelope) is unchanged for PR-table stats and
   reports; cycles are additive drill-down context, not a replacement
   metric.

## Consequences

- `src/lib/ci-cycles.ts` owns the pure grouping/summary logic (tested);
  `fetchPullRequestDetail` owns the enrichment query; the PR drill-down
  renders both sections.
- `Run.branchMatched` is a display-layer flag; no schema change.
- Future work (not in scope): GPU label→`resource_model` mapping so
  card-hours cover GPU workflows; persisting cycle metrics if reports need
  them.
