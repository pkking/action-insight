# ETL Follow-up Plan

## Context

PR #83 fixed oversized Supabase writes by chunking ETL upserts. PR #84 serialized per-repo ETL workflows to avoid overlapping scheduled collectors rewriting the same recent windows. PR #85 made local PR metrics recovery usable with environment-provided Supabase credentials and an optional `GITHUB_TOKEN`, and added PR metrics rebuild observability. PR #87 extended `pr_resolution_cache` to track resolution status (resolved, not_found, failed, rate_limited) and made SHA resolution resumable across runs.

After those changes, the frontend recovered to current data. Items 1, 2, 3, and 4 below are complete. The remaining item is only a conditional pagination revisit if rebuild scale or concurrency changes.

## Goals

- Keep raw workflow run collection independent from PR metrics rebuild failures.
- Make PR resolution resumable and cache-friendly across ETL runs.
- Reduce Supabase Free Plan database size pressure from raw `github_payload` storage.
- Keep enough operational visibility to detect stale frontend metrics quickly.

## Work Items

### 1. Split PR metrics rebuild from raw ETL collection ✅

**Completed in PR #85.**

Create an independent script and GitHub Actions workflow for rebuilding PR metrics from already-collected raw runs.

Expected shape:

- Keep the raw runs/jobs collector focused on GitHub Actions data ingestion.
- Add a separate PR metrics rebuild entry point that reads `runs` from Supabase and writes `pr_metrics` and `pr_workflows`.
- Allow the rebuild workflow to be triggered manually with repo/date parameters.
- Ensure GitHub API rate-limit or PR-resolution failures can be retried without re-fetching workflow runs.

Success criteria:

- Raw ETL can complete even if PR metrics rebuild is skipped or fails.
- PR metrics rebuild can be rerun for a date range using existing raw data.
- Logs report rows written and latest `created_at` for rebuilt metrics.

### 2. Make SHA to PR resolution resumable ✅

**Completed in PR #87.**

Reduce repeated GitHub API calls during PR metrics rebuild.

Expected shape:

- Expand `pr_resolution_cache` reuse so already-resolved SHAs are not fetched again.
- Persist unresolved or rate-limited SHA resolution state so a later run can resume.
- Batch resolution work with clear progress logging.
- Keep failed lookups distinguishable from "not a PR" results.

Success criteria:

- Rebuilding the same date window performs minimal duplicate GitHub API calls.
- A rate-limited rebuild can resume instead of restarting all lookups.
- Logs make cache hits, misses, unresolved items, and API calls visible.

### 3. Move raw payload storage out of Supabase ✅

**Completed via ADR-004 and the SQLite/LFS storage path.**

Move raw `github_payload` data to a repository-tracked SQLite database or equivalent repo artifact, leaving Supabase for queryable frontend metrics.

Expected shape:

- Store raw payloads in SQLite with stable keys for repo, run id, date, and event metadata.
- Keep Supabase tables focused on frontend-facing aggregates and normalized records.
- Add scripts for rebuilding Supabase metrics from the SQLite raw store.
- Document how the SQLite file is updated and committed.

Success criteria:

- Supabase database size grows mainly with structured metrics, not raw JSON payloads.
- A historical metrics rebuild can be performed from the SQLite raw store.
- The storage path is documented and reproducible in local recovery.

Status note (2026-07-03): per-repo SQLite databases under `etl/data/*.db` are tracked via Git LFS and serve as the local fallback/recovery store for GitHub Actions runs/jobs data. See [ADR-004](../adr/004-sqlite-db-lfs-storage.md).

### 4. Add operational checks for ETL freshness ✅

**Completed.**

Add lightweight checks around scheduled ETL runs and frontend data freshness.

Expected shape:

- Query latest `runs.created_at` and latest `pr_metrics.created_at` after ETL.
- Log stale-data warnings when `pr_metrics` lags raw runs by more than the expected window.
- Track Supabase database size manually or through a documented checklist while on the Free Plan.

Success criteria:

- ETL logs make stale PR metrics obvious before opening the frontend.
- The team has a repeatable check for Supabase Free Plan storage pressure.

### 5. Consider keyset pagination later

The current local rebuild script uses deterministic offset pagination with `created_at` and `id` ordering. This is acceptable for local recovery because PR #84 prevents overlapping repo collectors and the script is not a high-frequency online path.

Revisit keyset pagination if:

- PR metrics rebuild becomes a scheduled production workflow with large date windows.
- Rebuilds regularly scan enough rows for offset pagination to become slow.
- Concurrent writes to the scanned date range become common again.

## Priority

1. ~~Split PR metrics rebuild from raw ETL collection.~~ ✅ PR #85
2. ~~Improve SHA to PR resolution cache and resumability.~~ ✅ PR #87
3. ~~Move raw payload storage out of Supabase.~~ ✅ ADR-004 / SQLite LFS
4. ~~Add operational freshness and storage checks.~~ ✅ Done
5. Revisit keyset pagination only if rebuild scale or concurrency requires it.
