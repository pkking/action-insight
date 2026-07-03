---
title: feat: Implement workflow file and attempt scoped collection
type: feat
status: draft
date: 2026-07-03
origin: docs/adr/005-workflow-file-attempt-scoped-collection.md
---

# Plan: Workflow File and Attempt Scoped Collection

## Overview

Implement ADR-005 by moving tracked workflow analysis from run-level workflow rows to workflow file and attempt scoped records. The first committed slice already added structured tracked repository workflow configuration and validation. The remaining work migrates storage, collection, rebuild, and frontend metrics so reruns, workflow refs, job attempts, and eligible step data are represented explicitly.

## Problem Frame

Current storage treats a GitHub Actions run id as the workflow execution identity. That collapses reruns, makes PR workflow counts ambiguous, and ties job and step records to run-level state instead of a concrete attempt. Current workflow filtering also cannot fully express ADR-005's intended rules because raw run metadata, jobs, PR workflow links, and UI metrics are not yet grouped by workflow file basename, optional workflow ref, and run attempt.

The new design must keep existing run metadata usable while adding attempt-scoped execution records. It should converge historical data through bounded backfill instead of requiring a disruptive all-at-once migration.

## Requirements Trace

- R1. Match tracked workflows by workflow file basename and optional workflow ref, not workflow name.
- R2. Store stable run metadata separately from workflow attempts keyed by `run_id + run_attempt`.
- R3. Store jobs and steps using attempt identity: `run_id + run_attempt + job_id` and `run_id + run_attempt + job_id + step_number`.
- R4. Link PR metrics to workflow attempts rather than run ids.
- R5. Preserve every rerun attempt in PR counts, timing, success rates, and drill-down views.
- R6. Persist step data only for successful tracked workflow attempts whose workflow total duration exceeds the configured threshold.
- R7. Support threshold override precedence: exact-ref workflow, glob-ref workflow, file-only workflow, repository, defaults.
- R8. Backfill workflow file metadata from stored run payloads for historical rows inside the retention window.
- R9. Backfill jobs and eligible steps for newly tracked historical attempts within a bounded per-run API budget.
- R10. Surface missing tracked workflows, invalid timing samples, and pending backfill counts in logs or UI.

## Scope Boundaries

- Includes Turso schema, SQLite fallback schema, ETL collection, PR artifact rebuild, and frontend query semantics.
- Includes migration/backfill scripts needed to converge retained historical data.
- Includes tests for parser, matching, storage identity, rebuild metrics, and user-visible aggregation behavior.
- Does not introduce GitHub workflow metadata calls into daily collection. Online metadata calls remain limited to repository configuration validation.
- Does not delete old run, job, or step rows until replacement reads are proven and a cleanup plan exists.
- Does not expand the tracked repository list beyond `etl/repos.yaml`.

## Current State

### Completed Prerequisite

PR #136 added structured repository configuration with workflow file rules and validation:

- `etl/repos.yaml` now supports repo objects with `workflows[].file`.
- `etl/scripts/repos-config.ts` parses and validates workflow file basename rules.
- `etl/scripts/validate-repos.ts` can validate configured workflow files against GitHub.
- `src/lib/tracked-repos.js` and `/api/repos` read the new config while preserving repository selection behavior.

### Existing Storage Shape

- `runs` is keyed by GitHub run id and stores run-level status, conclusion, timestamps, and `steps_checked_at`.
- `jobs` is keyed by GitHub job id and references `runs(id)`.
- `steps` is keyed by `(job_id, number)`.
- `pr_workflows` links `pr_metrics` to `run_id`.

These are not sufficient for reruns or attempt-scoped metrics.

## Key Decisions

- Keep `runs.id` as stable GitHub run metadata and add a separate workflow attempt table instead of changing the primary key of `runs`.
- Add attempt-scoped job and step storage rather than overloading existing `jobs.id` and `steps(job_id, number)` identities.
- Use workflow file basename as the durable tracked workflow key; keep raw workflow path when available for diagnostics.
- Treat workflow ref as optional. File-only rules match all refs; ref-specific rules require a usable ref.
- Prefer additive schema changes first. Change rebuild and UI reads only after migration tests prove parity or intended differences.
- Use bounded backfill budgets for jobs and steps so scheduled ETL cannot unexpectedly exhaust API quota.

## Implementation Units

- [ ] **Unit 1: Add attempt-scoped schema and compatibility migrations**

  **Goal:** Add the tables and columns needed by ADR-005 without breaking current read paths.

  **Expected shape:**
  - Add workflow metadata columns to run-level storage: workflow file basename, workflow ref, raw workflow path, and parse status.
  - Add `workflow_attempts` keyed by `(run_id, run_attempt)` with attempt status, conclusion, timestamps, queue/runtime/total duration fields, tracked match metadata, jobs/steps fetch markers, and step policy hash.
  - Add attempt-scoped job and step tables keyed by `(run_id, run_attempt, job_id)` and `(run_id, run_attempt, job_id, step_number)`.
  - Add replacement PR link table keyed to workflow attempts.
  - Apply equivalent schema in `turso/schema.sql` and SQLite schema helpers.

  **Verification:**
  - Migration is idempotent.
  - Existing tests still pass without reading new tables.
  - New storage tests prove multiple attempts for the same run do not overwrite each other.

- [ ] **Unit 2: Parse workflow file/ref metadata from run payloads**

  **Goal:** Extract workflow file basename and optional ref from GitHub run metadata and stored run payloads.

  **Expected shape:**
  - Add a shared parser for workflow `path` values such as `.github/workflows/ci.yml@main`.
  - Persist parse result and explicit unavailable states for workflow file or ref.
  - Backfill retained historical runs from stored payloads where possible.
  - Keep run metadata for untracked workflows even when no tracked workflow rule matches.

  **Verification:**
  - Parser tests cover valid paths, missing refs, missing paths, malformed paths, file-only rules, exact refs, and glob refs.
  - Backfill script reports scanned rows, updated rows, unavailable file counts, unavailable ref counts, and errors.

- [ ] **Unit 3: Implement tracked workflow matching and threshold policy**

  **Goal:** Convert configured workflow rules into deterministic match and step eligibility decisions.

  **Expected shape:**
  - Match by workflow file basename and optional ref using precedence: exact ref, glob ref, file-only.
  - Reject ambiguous same-precedence matches.
  - Compute effective step threshold using workflow exact-ref, workflow glob-ref, workflow file-only, repo, then defaults.
  - Produce a stable step policy hash for each workflow attempt.

  **Verification:**
  - Unit tests cover precedence, ambiguous rules, ref-unavailable matching, workflow-file-unavailable exclusion, and threshold overrides.
  - Validation continues to reject workflow names and workflow paths as config keys.

- [ ] **Unit 4: Write workflow attempts during collection**

  **Goal:** Teach `collect.ts` to write attempt-scoped records while preserving current run ingestion.

  **Expected shape:**
  - Create or update `runs` for stable run metadata.
  - Create or update `workflow_attempts` for each collected `run_attempt`.
  - Mark whether the attempt is tracked and which rule matched it.
  - Only fetch jobs for tracked workflow attempts that need workflow details or backfill.
  - Preserve current GitHub API cost controls and rate-limit behavior.

  **Verification:**
  - Collector tests prove reruns produce separate workflow attempts.
  - Untracked workflows keep run metadata but do not fetch workflow details.
  - Rate-limit aborts still persist partial safe progress.

- [ ] **Unit 5: Persist attempt-scoped jobs and eligible steps**

  **Goal:** Store workflow details under attempt identity and apply step eligibility rules.

  **Expected shape:**
  - Jobs are stored against `(run_id, run_attempt, job_id)`.
  - Steps are stored only for successful tracked attempts whose workflow total duration exceeds the effective threshold.
  - Job timing and step timing compute queue/runtime/total metrics consistently with `CONTEXT.md`.
  - Invalid timing samples are counted and surfaced without poisoning percentile metrics.

  **Verification:**
  - Tests cover rerun jobs with reused job names, step filtering for short successful workflows, failed workflows, and invalid timestamps.
  - Storage tests prove attempts do not share jobs or steps accidentally.

- [ ] **Unit 6: Add bounded workflow details and step eligibility backfill**

  **Goal:** Let historical retained data converge after configuration or threshold changes.

  **Expected shape:**
  - Add backfill selectors for newly tracked attempts without jobs.
  - Add backfill selectors for attempts whose step policy hash changed or whose eligible steps are missing.
  - Bound backfill by retention window and per-run budget, defaulting to 100 attempts.
  - Log pending and completed workflow details and step eligibility backfill counts.

  **Verification:**
  - Dry-run mode reports planned work without writing.
  - Backfill tests cover no-op, newly tracked workflow, threshold increase/decrease, and API budget exhaustion.

- [ ] **Unit 7: Rebuild PR artifacts from workflow attempts**

  **Goal:** Move PR metrics and workflow links from run-level rows to tracked workflow attempts.

  **Expected shape:**
  - PR workflow links point to `(run_id, run_attempt)` records.
  - PR wall time, total workflow time, current CI success, attempt success rate, and workflow counts use tracked workflow attempts.
  - PRs without tracked CI are counted separately.
  - Non-terminal attempts are retained for live visibility but excluded from success rates and completed-duration percentiles.

  **Verification:**
  - Rebuild tests cover multiple attempts for one workflow, failed reruns, latest terminal current success, PRs with no tracked attempts, and partial CI history.
  - Existing PR detail behavior remains usable for already-supported fields.

- [ ] **Unit 8: Update frontend data fetchers and dashboard views**

  **Goal:** Expose attempt-scoped workflow, job, and step data without regressing existing dashboard workflows.

  **Expected shape:**
  - Repository overview metrics use tracked workflow attempt aggregates.
  - PR detail views show tracked workflow attempts and distinguish current success from attempt success rate.
  - Workflow, job, and step timeline/cluster views group by workflow file and workflow ref.
  - UI copy explains queue/runtime/total duration and step coverage constraints.

  **Verification:**
  - Component and data-fetcher tests cover empty tracked CI, reruns, missing tracked workflows, and step coverage notes.
  - Existing runner label filtering remains correct after workflow attempt joins.

- [ ] **Unit 9: Operationalize validation, migration, and rollback**

  **Goal:** Make the migration safe to run in CI and production-like environments.

  **Expected shape:**
  - Add help output and dry-run checks for migration and backfill scripts.
  - Add freshness checks for workflow attempts versus raw runs and PR metrics.
  - Document recovery path for Turso and SQLite fallback.
  - Keep a rollback path that disables attempt-scoped reads while preserving additive schema.

  **Verification:**
  - `npm run lint`, `npm test`, ETL focused vitest files, migration dry-run/help, and config validation pass.
  - Logs identify stale attempts, stale PR metrics, and pending backfill work.

## Risks

- **Schema drift between Turso and SQLite**: Keep schema changes duplicated and covered by migration tests.
- **API budget growth**: Backfill must be budgeted and observable before it runs in scheduled collection.
- **Metric semantic changes**: PR success and duration metrics will change when reruns are counted correctly. UI and docs need clear labels.
- **Historical incompleteness**: Older runs may lack workflow path/ref metadata. Treat unavailable states explicitly rather than guessing.
- **Incremental read migration**: Existing frontend reads should remain stable until attempt-scoped rebuild is proven.

## Open Questions

- Should old `jobs` and `steps` tables remain as compatibility caches after attempt-scoped tables are live, or should a later cleanup remove them?
- Should `pr_workflows` be migrated in place or replaced by a new attempt link table and compatibility view?
- What UI should own pending backfill visibility: logs only, dashboard warning, or both?
- How long should the fallback period be where both run-level and attempt-level PR artifact rebuilds can be compared?

## Suggested PR Sequence

1. Schema and parser foundation: additive tables/columns, parser, matching tests.
2. Historical workflow file backfill: parse retained raw payloads and report unavailable metadata.
3. Collector writes workflow attempts: keep current UI reads unchanged.
4. Attempt-scoped jobs and eligible steps: add policy hashing and bounded details backfill.
5. PR artifact rebuild migration: compute metrics from workflow attempts and compare outputs.
6. Frontend read migration: update dashboard data fetchers and labels.
7. Cleanup and docs: remove obsolete run-level assumptions after parity is proven.

