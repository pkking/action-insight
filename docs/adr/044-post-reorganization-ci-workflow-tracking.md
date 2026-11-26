# ADR-044: Track post-reorganization CI workflows (November 2026 audit)

## Status

Accepted (2026-11-26)

## Context

Repos in this ecosystem reorganized their CI during November 2026, and `etl/repos.yaml` drifted from what actually runs. A systematic audit on 2026-11-26 (23 repos, 67 configured workflows, cross-checked against GitHub for the last 7 days and November totals) found three more blind spots of the same class as the original `triton-ascend` one:

- `triton-lang/triton-ascend` moved its main PR Integration Tests from `ci.yml` (single digits/day after 11/09) to `ascend-ci.yml` (1,219 runs since 10/22, PR-triggered). Only `ci.yml` was tracked.
- `ascend/pytorch`: `nightly.yml` and `nightly-a3.yml` stopped ~11/15; the replacements `nightly-upstream-release-a5.yml` (20 runs) and `nightly-upstream-release-a3.yml` (24 runs) were untracked.
- `hiyouga/LlamaFactory`: the configured `tests.yml` runs on macos/windows CPU runners; the CUDA-side PR CI `tests_cuda.yml` (157 November runs) was untracked, leaving LlamaFactory GPU/NPU comparison one-sided.
- `areal-project/AReaL`: only the GCP GPU `test-areal.yml` was tracked; the Ascend-side `ascend-pr-tests.yml` (50 November PR runs) was untracked.

Checked and deliberately excluded: `Ascend/sglang` `pr-test.yml` (360 November runs) — its own jobs run on ubuntu-latest, but it triggers the reusable `pr-test-extra.yml` whose GPU partitions (`1-gpu-small`, `1-gpu-large`, `2-gpu-large`, `4-gpu-b200`) hold the repo's GPU-side PR test time; tracking it is deferred until its GPU runner-label family gets card-count governance rules (the NPU-focused repo's tracked `full-test-npu.yml`/`pr-test-npu.yml` keep its NPU coverage complete). Also excluded: `verl` e2e variant workflows (each ≤ a few runs/week, below the ADR-041 allowlist bar individually); `Ascend/cann-container-image` `*_test` build workflows (build-only, no test timing); lint/labeler/docs workflows everywhere.

## Decision

Add the post-reorganization workflows to `etl/repos.yaml`, each aligned with its repo's existing comparison conventions:

- `triton-lang/triton-ascend`: `ascend-ci.yml` (`npu_drilldown`, `report_name: Integration Tests (Ascend CI)`, same `comparison_group: triton`); keep `ci.yml` for residual runs and history.
- `ascend/pytorch`: `nightly-upstream-release-a5.yml` and `nightly-upstream-release-a3.yml` (comparison `Nightly`); keep the dormant `nightly.yml`/`nightly-a3.yml` configured in case they are re-enabled — retained entries cost only ETag-cached empty lists.
- `hiyouga/LlamaFactory`: `tests_cuda.yml` (comparison `PR`), completing the CUDA side next to the tracked `tests_npu.yml`.
- `areal-project/AReaL`: `ascend-pr-tests.yml` (`npu_drilldown`, comparison `PR`).

Distinct `report_name`s prevent same-named GitHub workflows from colliding in report rows keyed by configured display names.

Backfill the November windows for the new workflows with scoped `collect.ts` runs; the hourly cron's rolling `--days 3` keeps them current once this config reaches `main`.

## Consequences

- triton-ascend run counts, attempt timing, queue and NPU drilldown figures for 11/09 onward change materially once backfilled; earlier comparisons that used only `ci.yml` reflect mainly the pre-11/09 period and should be re-run before being quoted.
- LlamaFactory gains its first tracked CUDA-side PR CI; AReaL gains its first tracked Ascend-side PR CI. Earlier "no NPU samples" conclusions for AReaL were an artifact of the untracked workflow.
- Dormant-but-retained entries (`ROLL` `ci-npu-mindspeed.yml`, `sglang-omni` `release-docker-npu.yml`, `ascend/pytorch` `pytorch_ci_trigger_push.yml`, `fla-org` retired workflows, `mojo_opset` smokes) are kept: removal saves nothing while risking missing re-enabled runs.
- November backfill cost stays bounded (≈1.6k new runs across the four repos, ETag-cached re-lists for already-collected workflows).
- Tracking drift of this kind should be re-checked when a repo's daily volume collapses; the 2026-11-26 audit method (per-workflow 7-day and month totals vs config) is the template.
