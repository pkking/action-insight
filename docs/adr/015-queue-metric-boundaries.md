# ADR-015: Queue metrics are execution-scoped

**Status**: Accepted  
**Date**: 2026-09-16

## Context

The dashboard previously labeled the elapsed time from PR creation to first tracked CI as `Queue`. That interval includes author/reviewer delay, draft periods, manual triggers, and collection gaps; it is not scheduler queue time. Workflow attempts also derived queue from a run-level start timestamp, which does not express the requested boundary between workflow scheduling and the first job execution.

## Decision

Queue is defined only for executable scopes:

- **Workflow Queue**: `workflow run.created_at → MIN(job.started_at)` across jobs in the same run attempt.
- **Job Queue**: `job.created_at → job.started_at`.
- **PR Queue**: does not exist. PR views must not label or present PR-to-CI time as queue.

A queue sample is unavailable when either endpoint is absent, no job has started, or the calculated duration is negative. It is not coerced to zero. Workflow-attempt persistence is recomputed from its collected jobs; historical stored workflow queue values must be backfilled before workflow queue reporting is considered comparable across the retention window.

PR end-to-end remains a lifecycle duration (`PR created_at → merged_at`), distinct from queue. PR timing charts and tables show CI Runtime and Review only.

## Consequences

- Dashboard, ETL, report, and API code must use these definitions consistently; no run-start or PR-created-to-CI interval may be labeled Queue.
- Existing `workflow_attempts.queue_duration_seconds` values need a local backfill from `workflow_jobs` after deployment.
- Missing-job history reduces workflow queue coverage and must remain visible as unavailable rather than estimated.
- This supersedes ADR-008's implicit workflow queue interpretation while retaining its attempt-scoped read-model approach.
