# ADR-044: Track triton-ascend ascend-ci.yml after CI reorganization

## Status

Accepted (2026-11-26)

## Context

`triton-lang/triton-ascend` moved its main PR CI off `ci.yml` during early November 2026. GitHub shows `ci.yml` dropping from 60–105 runs/day (11/01–11/08) to single digits after 11/09, while `ascend-ci.yml` (also displayed as "Integration Tests", PR-triggered) accumulated 1,214 runs in November. Our `etl/repos.yaml` tracked only `ci.yml`, so since 11/09 the local database missed the repo's actual PR CI almost entirely — e.g. 11/25 held 1 tracked run while `ascend-ci.yml` alone ran 73 times.

This was surfaced on 2026-11-26 while checking whether 11/25 data was sufficient for cross-project PR-duration comparison.

## Decision

Add `ascend-ci.yml` to the `triton-lang/triton-ascend` entry with `npu_drilldown: true`, `report_name: Integration Tests (Ascend CI)` and `comparison_name: PR` (same `comparison_group: triton`). Keep `ci.yml` configured: it still runs occasionally and its historical rows stay in scope.

The distinct `report_name` prevents the two same-named GitHub workflows from colliding in report rows keyed by configured display names.

Backfill the November window for `ascend-ci.yml` with a scoped `collect.ts --days` run; the hourly cron's rolling `--days 3` keeps it current once this config reaches `main`.

## Consequences

- triton-ascend run counts, attempt timing, queue and NPU drilldown figures for 11/09 onward change materially once backfilled; earlier comparisons that used only `ci.yml` reflect mainly the pre-11/09 period and should be re-run before being quoted.
- November collection cost is bounded (~1.2k runs plus one jobs call per tracked run, within a single token lane).
- Other repos in this ecosystem reorganized CI in November as well (e.g. tilelang-mlir-ascend's `base_ci.yml` deletion noted in repos.yaml); tracking gaps of this kind should be checked when a repo's daily volume collapses.
