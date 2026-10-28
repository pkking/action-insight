# ADR-023: Attempt-scoped durations exclude the idle gap before reruns

**Status**: Accepted

## Context

A rerun (`run_attempt > 1`) shares the run row with its original trigger:
GitHub keeps `created_at` at the **first** attempt's creation and resets
`run_started_at` per attempt. The ETL computed `workflow_attempts` durations
from `created_at`:

- `total_duration_seconds` = created_at → completed
- `queue_duration_seconds` = created_at → first job started

For reruns this counted the **idle gap between attempts** (hours to days of
human/bot re-trigger delay) as duration and queue. vllm-ascend run 37794173436
(attempt 2) showed 59.7h "total" while GitHub's UI — and actual execution —
was 28m56s; the other 59h was the gap between the 10-08 trigger and the 10-11
rerun. Across the local DB, 9,607 rerun attempts carried **141,394 hours of
phantom duration**, inflating every mean/P90 built on `total_duration` for
rerun-heavy workflows (vllm-ascend E2E mean: 1.21h reported vs 0.74h real).

## Decision

1. **Rerun attempts (`run_attempt > 1`)**:
   - `total_duration_seconds` = `run_started_at` → completed (equals
     `runtime_seconds`; matches GitHub UI semantics for a rerun)
   - `queue_duration_seconds` = NULL — a rerun's trigger time is unknowable,
     so its queue is unknown, never the inter-attempt gap.
2. **First attempts (`run_attempt = 1`)** keep the created-based semantics
   (queue included in total), unchanged.
3. **Backfill**: existing rows were corrected in place —
   `UPDATE workflow_attempts SET total_duration_seconds = runtime_seconds
   WHERE run_attempt > 1 AND runtime_seconds IS NOT NULL AND total_duration_seconds
   IS DISTINCT FROM runtime_seconds` (9,607 rows) and queue nulled for reruns
   (7,266 rows). Rows without `run_started_at` keep their legacy values.
4. Job-level metrics are unaffected: rerun attempts have their own
   `workflow_jobs` rows whose `created_at` belongs to that attempt's
   execution, so job queue/runtime were already honest.

## Consequences

- Workflow tab P50/P90/avg and all `total_duration` consumers now reflect
  per-attempt reality; means for rerun-heavy workflows drop toward their
  runtime-based values (vllm-ascend E2E: 1.21h → 0.74h mean, P90 2.32h →
  1.65h).
- Rerun queue times are reported as unknown rather than misleading. Queue
  analysis for reruns is a gap until GitHub exposes per-attempt trigger
  times (not planned).
- The `runs.duration_seconds` legacy column and PR-level envelope metrics
  (ADR-020 cycles mitigate this at the PR drill-down) still originate from
  run-level `created_at`; they are out of scope here.
