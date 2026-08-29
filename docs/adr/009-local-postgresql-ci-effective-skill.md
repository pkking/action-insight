# ADR-009: CI effective skill reads local PostgreSQL

## Status

Accepted

## Context

The imported CI analysis script previously selected between Turso and per-repository SQLite files. Action Insight now stores collected workflow, job, step, and PR metrics in the local PostgreSQL database. Keeping additional database paths would make report results depend on stale duplicate stores. A report must distinguish a job waiting for a runner from a job blocked by upstream `needs` dependencies.

## Decision

Add the project skill at `.agents/skills/ci-effective-report/` and make `PG_DATABASE_URL` its only data source. The copied `.github-ci-efficiency.yaml` defines the default repository and workflow comparison set. A separate `config/drilldown-workflows.yaml` is the explicit allowlist for PR/NPU drill-down: workflows not listed there—including scheduled/nightly and CUDA/GPU workflows—are excluded from the HTML payload. Workflow files are the stable identity when configured because GitHub `run-name` may replace the display name with a PR title; report rows normalize those runs back to the configured workflow name. Job reads combine legacy `jobs` rows with missing attempt-scoped rows from `workflow_jobs`. The backfill command treats workflow files currently listed in `etl/repos.yaml` as tracked even when old `workflow_attempts.tracked` flags predate that configuration, allowing newly configured workflows to recover jobs without recollecting every run. The client starts every report query transaction as read-only; API-backed repair remains an explicit ETL command. Job queue metrics use `jobs.created_at → jobs.started_at`; workflow-level first-dispatch latency may use `runs.created_at → earliest job.started_at`, but is not aggregated as job queue. When a reporting window has no Job rows, resource requirements may use the latest stored runner labels for that workflow; historical rows never contribute to the window's card-hour totals.

## Trade-offs

- Reports use the same current data as the application and avoid GitHub API cost.
- `pg8000` (pure-Python, BSD-3-Clause), PyYAML, and openpyxl are isolated in the skill's uv environment; the pure-Python driver keeps the skill self-contained with no compiled wheels and avoids GPL-flagged `psycopg-binary` that the repository's `deny-licenses: GPL-3.0` dependency review rejects.
- A report cannot fill missing local history automatically; users must run the existing ETL collection or rebuild commands first.
- Every blank E2E or queue metric carries an `空值判断依据` derived from run/job counts, so an intentional absence is distinguishable from missing ETL data.

## Consequences

Future report metrics must remain compatible with `pg/schema.sql`. Every repository in `.github-ci-efficiency.yaml` and `config/drilldown-workflows.yaml` must also appear with the same case-sensitive `owner/repo` name in `etl/repos.yaml`; a skill regression test enforces this contract. Queue reports must not substitute run creation time for job creation time. Schema or metric-contract changes require updating this ADR and the skill tests. Repository credentials must stay in `PG_DATABASE_URL` or `.env`; configuration files must not contain secrets.
