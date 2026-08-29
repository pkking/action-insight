# ADR-010: CI raw data collector skill

## Status

Accepted

## Context

CI efficiency and drilldown reports read local PostgreSQL. Missing or stale runs/jobs/steps previously required ad-hoc commands, which made collection scope, Docker connection settings, and completeness checks inconsistent. Raw collection and PR artifact rebuild are separate operations and must not be conflated.

## Decision

Add `.agents/skills/ci-raw-data-collector/` as the model-invoked collection entrypoint. It uses the repository's existing `etl/scripts/collect.ts` and, for gaps, `backfill-missing-jobs.ts`, writing to the PostgreSQL service launched by Docker Compose through `PG_DATABASE_URL`. It requires an explicit date/repository scope, prefers narrow reverse collection, requires a post-collection coverage audit, and hands off to `rebuild-pr-artifacts` only when PR-derived report data is also needed.

The skill does not embed credentials or silently call GitHub API without `GITHUB_TOKEN`. It reports partial coverage instead of claiming completeness.

## Trade-offs

- Collection instructions are centralized and reusable by report skills.
- The skill depends on the repository's current ETL CLI and compose service names; it verifies `--help` and `docker compose config --services` rather than duplicating their full implementation.
- A post-collection audit adds a command, but prevents empty-job and partial-history reports from looking valid.

## Consequences

Future raw-data/report workflows should invoke this skill when local coverage is insufficient. Changes to ETL CLI flags, PostgreSQL connection defaults, or completeness criteria require updating the skill and this ADR. Raw collection must remain separate from PR artifact rebuild and report generation.
