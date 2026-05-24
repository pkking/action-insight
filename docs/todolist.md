# Todo List

## ETL Reliability

- [ ] Fix `etl/scripts/rebuild-pr-artifacts-local.ts` to use `GITHUB_TOKEN` and `Octokit` when available, so local PR metrics rebuild works for repos whose raw payloads do not include `pull_requests`.
- [ ] Add explicit PR metrics rebuild observability to ETL logs, including the number of PR metrics rows written and the latest `created_at` written to Supabase.
- [ ] Separate PR metrics rebuild from raw runs/jobs collection so rate-limit failures can be retried independently without re-fetching workflow runs.

## ETL Throughput

- [ ] Reduce GitHub API pressure by expanding reuse of `pr_resolution_cache` and making SHA resolution resumable across runs.
- [ ] Keep per-repo ETL workflows serialized with `concurrency` so overlapping scheduled runs do not rewrite the same recent windows.

## Storage

- [ ] Move raw `github_payload` storage out of Supabase and into a repository-tracked SQLite database to avoid Free Plan database size pressure.

