# Todo List

## ETL Reliability

- [x] Keep per-repo ETL workflows serialized with `concurrency` so overlapping scheduled runs do not rewrite the same recent windows.
- [x] Separate PR metrics rebuild from raw runs/jobs collection so rate-limit failures can be retried independently without re-fetching workflow runs. See [ETL Follow-up Plan](plans/2026-05-24-001-etl-followup-plan.md).
- [x] Add ETL freshness checks that compare latest raw `runs.created_at` with latest `pr_metrics.created_at` and warn when metrics lag raw data.

## ETL Recovery

- [x] Fix `etl/scripts/rebuild-pr-artifacts-local.ts` to use `GITHUB_TOKEN` and `Octokit` when available, so local PR metrics rebuild works for repos whose raw payloads do not include `pull_requests`.
- [x] Add explicit PR metrics rebuild observability to ETL logs, including the number of PR metrics rows written and the latest `created_at` written to Supabase.

## ETL Throughput

- [x] Reduce GitHub API pressure by expanding reuse of `pr_resolution_cache` and making SHA resolution resumable across runs. (PR #87)
- [x] Track cache hits, cache misses, unresolved SHAs, and GitHub API calls in PR metrics rebuild logs. (PR #87)

## Storage

- [x] Move raw `github_payload` storage out of Supabase and into a repository-tracked SQLite database to avoid Free Plan database size pressure. See [ADR-004](adr/004-sqlite-db-lfs-storage.md).
- [x] Document the recovery path for rebuilding metrics from the repository-tracked SQLite/Turso raw store. See README local maintenance commands and [ETL Follow-up Plan](plans/2026-05-24-001-etl-followup-plan.md).
