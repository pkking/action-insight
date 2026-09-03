# ADR-011: Write execution details only at workflow-attempt scope

**Status**: Implemented
**Date**: 2026-08-28

## Context

The collector wrote every job and step twice: into legacy `jobs`/`steps` and into attempt-scoped `workflow_jobs`/`workflow_steps`. The latter is the canonical model from ADR-005 and is what the application uses for attempt-aware drill-down. The duplicate writes consumed storage and database time; current production data has millions of duplicate step records.

## Decision

New collection writes raw workflow metadata to `runs`, then writes jobs and eligible steps only through `workflow_attempts`, `workflow_jobs`, and `workflow_steps`. Legacy `jobs` and `steps` remain read-only compatibility sources for historical rows not yet present in attempt-scoped tables. Readers prefer attempt-scoped rows and fall back to legacy rows only when needed.

A completed execution cache is keyed by `(run_id, run_attempt)`, GitHub `updated_at`, and `step_policy_hash`; reruns are never treated as the first attempt.

## Trade-offs

- Existing legacy data is retained, so no destructive migration is required.
- Historical reports may use legacy fallback until retention naturally replaces old rows.
- Full physical removal of legacy tables is deferred until all retained history has attempt-scoped coverage and consumers no longer need compatibility reads.

## Constraints

New code must not add writes to `jobs` or `steps`. Any removal of the compatibility tables requires a separate migration and coverage check.
