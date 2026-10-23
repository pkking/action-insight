# ADR-022: Merge-time NPU/GPU CI status on the PR table

**Status**: Accepted

## Context

The PR table shows one aggregate CI signal per PR (envelope runtime, forced
merge), but for the tracked repos the interesting question at merge time is
per-**resource class**: did the NPU CI pass when this PR merged? sglang PR
#41907 merged with NPU CI failing on all 13 push cycles — invisible in the
current table. Repos track paired workflows (e.g. sglang `pr-test-npu.yml`
on Ascend vs `pr-test.yml` on GB300; VeOmni `npu_e2e_test.yml` with `910b-8`
runners vs `gpu_e2e_test.yml` with `l20-8`).

## Decision

1. **Classification evidence** (per PR, per workflow file, over that PR's
   linked attempt jobs): a workflow is **NPU** when any linked job has a
   mapped Ascend `resource_model` (any `linux-aarch64-*` except the `cpu`
   group) or an NPU-ish runner label (`910|310p|ascend|npu|atlas`,
   case-insensitive). Workflows with collected jobs but no NPU evidence are
   **GPU/other** (unmapped x86/GPU runners). Workflows without collected
   jobs have no class and contribute nothing — the badge renders "—".
2. **Status semantics**: per class, the conclusion of the **latest linked
   attempt that started at or before `merged_at`** (`wa.created_at <=
   merged_at`). Badges: success ✓ (green), failure ✗ (red), cancelled ⊘
   (amber), no linked attempt of that class — (grey). The column header
   tooltip documents the classification and the "—" meaning.
3. **Read model**: `fetchPrMergeCiStatus` computes both in one SQL pass
   over `pr_metrics ⋈ pr_workflow_attempts ⋈ workflow_attempts ⋈ runs ⋈
   workflow_jobs` (LEFT JOIN; the job-presence window guards the class
   evidence). `PrMetricRow` gains `pr_metric_id` (needed as the map key);
   `PrTableRow` gains `npuCiConclusion` / `gpuCiConclusion`.

## Trade-offs and known limits

- Classification is heuristic. Label coverage is uneven (sglang labels are
  empty, so its NPU evidence relies on mapped `resource_model`; VeOmni's
  NPU runners are unmapped, so it relies on labels). The union of both
  signals covers every tracked repo's pairing today, but a new repo with
  neither signal will show its workflows as GPU/other.
- Status derives from `pr_workflow_attempts` links only. Partially-linked
  PRs (`partial_ci_history`, e.g. sglang under SHA-resolution budget) may
  show "—" or an older attempt's conclusion until rebuild rounds complete
  the links. The PR drill-down's branch-matched view remains the
  authoritative per-PR timeline.
- "Latest attempt started ≤ merged_at" can include a run that finished
  after the merge; that matches "what the author saw when merging" closely
  enough and avoids dropping in-flight CI.
- A workflow mixing NPU and non-NPU jobs classifies as NPU (any-evidence).
  None of the tracked pairings do this today.

## Consequences

- The PR table gains a "Merge CI" column (NPU + GPU badges) after
  CI Runtime; the empty-state `colSpan` grows to 7.
- Future GPU `resource_model` mapping (ADR-020 follow-up) would tighten the
  GPU/other class from "no NPU evidence" to positive GPU evidence.
