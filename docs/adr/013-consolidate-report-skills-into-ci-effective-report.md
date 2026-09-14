# ADR-013: Consolidate report skills into ci-effective-report

**Status**: Accepted
**Date**: 2026-09-14

## Context

The repository currently ships two report skills with overlapping scope:

- `.agents/skills/ci-efficiency-report/` calls the GitHub API directly (backed by its own `data/<owner>/<repo>/` cache), analyzes any repository on demand, and produces single-repo deep dives in `monthly_summary` / `daily_diagnostic` modes with E2E distribution buckets, drag rankings, longest-job summaries, mandatory raw appendix sheets, and a test case counter (`test_case_counter.py`) that clones repositories to count test files.
- `.agents/skills/ci-effective-report/` (ADR-009) reads only the local PostgreSQL database shared with the application and produces multi-project Excel/HTML comparison reports with drill-down and mandatory empty-value justifications.

Maintaining both creates three concrete problems:

1. **Metric drift**: the same question answered by both skills yields different numbers. The efficiency skill computes queue duration at run level (`runs.started_at - runs.created_at`), while ADR-009 fixes the report contract at job level (`jobs.created_at -> jobs.started_at`) and explicitly forbids substituting run-level time. Two independent implementations guarantee this divergence recurs.
2. **Duplicate data paths**: the efficiency skill keeps a second, privately managed cache that goes stale relative to the PostgreSQL store the application and reports read, contradicting the single-source-of-truth direction of ADR-007/009.
3. **API cost**: the efficiency skill's API-backed backfill duplicates what `ci-raw-data-collector` (ADR-010) already standardizes, against the repository's cost-consciousness rules.

Analysis of the two skills shows `ci-effective-report` already covers the shared surface (P90 queue/execution metrics, per-workflow/job/step breakdowns, drill-down HTML with evidence) for every repository in `etl/repos.yaml`. The efficiency skill's remaining unique value is the report formats and the test-case counter — presentation-layer work that can move — plus one capability: on-demand analysis of repositories never configured for collection. That capability is currently unused: all reporting targets are the tracked repositories in `etl/repos.yaml`, and ad-hoc single-repo analysis outside that set is not a requirement.

## Decision

Consolidate to two skills with a strict division of labor:

- **`ci-raw-data-collector`** is the only skill that calls the GitHub API. It owns all raw runs/jobs/steps collection, gap repair, and coverage auditing.
- **`ci-effective-report`** is the only report exit. Every report — comparison, monthly management summary, daily diagnostic — is generated from local PostgreSQL through `ci_analyze.py`, reusing the existing query layer and ADR-009 metric contracts.

`ci-efficiency-report` is retired after its unique value is migrated:

1. `monthly_summary` and `daily_diagnostic` become `--report-mode` values on `ci_analyze.py`, including the management summary, current-problem list, and "fix first vs keep tracking" interpretations.
2. CI E2E distribution buckets (`<60m`, `60-120m`, `120-240m`, `>240m`), workflow drag ranking (run-count aware, distinguishing frequent drag from rare outliers), and the longest-job summary move into `ci_analyze.py` outputs.
3. The mandatory raw appendix (Workflow Raw / Job Raw / Step Raw worksheets preserving all in-scope rows with traceable identifiers) becomes part of the `ci_analyze.py` Excel output.
4. Test case statistics are unified on the ETL path (`etl/scripts/collect-test-case-stats.ts` writing to PostgreSQL); the repo-cloning `test_case_counter.py` is dropped.

Migrated modes must reuse the existing report query layer rather than re-implement metric computation, so queue/execution semantics remain job-level per ADR-009 and empty-value justifications remain mandatory in every output.

Removal of `.agents/skills/ci-efficiency-report/` happens only after the migration lands and its outputs are validated against historical reports; until then the two skills coexist but the efficiency skill receives no new features and no new callers.

## Trade-offs

- **Lost capability**: reports can no longer analyze a repository that was never configured for collection. This is accepted because no current requirement needs it. If a future ad-hoc target appears, the path is to add it to `etl/repos.yaml` and run the collector — not to revive an API-calling report skill. Re-adding collection configuration is minutes of work; re-adding a second metric implementation is a standing drift risk.
- **Migration cost**: porting report modes, buckets, rankings, and raw appendix sheets into `ci_analyze.py` is a one-time, bounded effort against the ongoing cost of keeping two skills' metric definitions in sync.
- **Hard local-PostgreSQL dependency**: every report now requires collected data before it can run. Reports cannot self-backfill missing history — this is intentional and already the ADR-009 contract; the collector skill exists precisely to fill that role.

## Consequences

- New report requirements are implemented only in `ci-effective-report`, reading local PostgreSQL. Metric definitions have exactly one implementation.
- ADR-009 contracts apply to all report modes: job-level queue metrics, `workflow.file` stable matching, `static_resources` priority, mandatory empty-value justifications, read-only report transactions.
- `etl/repos.yaml` remains the single source of analysis targets; a repository must be added there (and collected) before it can appear in any report.
- The skill regression test enforcing that `.github-ci-efficiency.yaml` and `config/drilldown-workflows.yaml` repositories appear in `etl/repos.yaml` continues to apply; migrated modes add coverage in `test_ci_analyze.py`.
- Documentation referencing the efficiency skill in historical plans/brainstorms is left as-is; living docs (README, skill listings) are updated at removal time.
- Schema or metric-contract changes still require updating ADR-009/ADR-013 and the skill tests.

## Constraints

- No GitHub API calls from report skills, under any circumstances; missing data is repaired by `ci-raw-data-collector` before reporting.
- `ci-efficiency-report` is frozen during migration: no new features, no new callers.
- Deletion of the efficiency skill requires the migrated outputs to be validated first (monthly and daily modes produced from local PostgreSQL, raw appendix completeness, empty-value justifications present).
- PR artifact rebuild remains a separate ETL operation and must not be folded into either skill.
