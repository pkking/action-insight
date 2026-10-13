# ADR-018: Keep resource-hour units and coverage gaps separate

**Status**: Accepted

## Context

Repository-level job resource occupancy is useful for CI reports, but accelerator-card hours, CPU-core hours, and unmeasurable runner occupancy are different quantities. Summing them under one machine-hour column or assigning an unknown runner a quantity of one produces plausible but misleading totals. The domain model defines Machine-Hours from valid job runtime and known positive accelerator quantity and requires unknown-cost samples to remain visible.

## Decision

The `仓库机时` workbook sheet uses separate `加速卡机时` and `CPU核时` columns. Only completed jobs with valid, nonnegative started-to-completed timing and positive known resource counts contribute. Accelerator quantities reuse the report's existing physical-card normalization (including A3's two-die convention); CPU quantities require an explicit positive core count in runner labels. Invalid explicit accelerator counts are not repaired by guessing a quantity or interpreting them as zero-cost samples.

Each repository has a clearly named known-resource subtotal and resource-model child rows. Children are already included in subtotals. Inapplicable units are blank on child rows; there is no mixed-unit total. Zero runtime is a valid zero-cost measured sample. Unknown-cost jobs are excluded from numeric subtotals and counted, with invalid-timing samples exposed as an overlapping subset. Nonterminal jobs are separately counted and excluded from formal occupancy metrics.

## Trade-offs and scope

Separate columns are less compact than one total, but maintain dimensional correctness and make coverage gaps auditable. Unknown runner-hours are deliberately not estimated. These values express attributed runner occupancy, not utilization, money, or complete capacity consumption. The sheet uses the already-selected reporting-window runs/jobs and does not use historical resource hints to fabricate costs or make additional GitHub API calls.

No storage or existing resource-pool calculations change. Reporting configuration consolidation is a separate PR; this sheet works before and after that migration.

## Constraints

Metric header comments must explain units, subtotal/child double counting, and coverage counters. Future extensions must retain separate dimensional quantities and must not present an unmeasurable sample as a known zero or one runner-hour. Regression tests cover mixed units, invalid timing/counts, unknown resources, zero runtime, nonterminal jobs, empty repositories, and the actual workbook-writing path.
