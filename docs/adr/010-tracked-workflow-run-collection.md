# ADR-010: Collect tracked workflow runs at the GitHub API boundary

## Status

Accepted

## Context

The collector configured jobs and steps only for tracked workflows, but enumerated every repository workflow run through the repository-wide Actions runs endpoint first. High-volume repositories such as sglang saturated the endpoint's 1,000-result cap, forcing recursive time-window splitting over unrelated workflows and preventing timely collection of the workflows used by CI reports.

## Decision

When `etl/repos.yaml` configures workflow files for a repository, pass each configured filename directly to GitHub's workflow-specific runs endpoint. Continue using repository-wide run listing only for repositories without workflow rules.

Conditionally validate recent tracked-workflow collection windows with a durable ETag keyed by repository, workflow file, and exact window. A `304 Not Modified` response skips response parsing, persistence, and jobs collection for that workflow window. Store a new ETag only after the changed window's data and collection checkpoint succeed; incomplete work must not publish a validator that could hide missing writes on the next cycle.

## Consequences

Raw runs and execution details collected for configured repositories are limited to tracked workflows. This matches CI efficiency and drilldown report scope and avoids unrelated-run API pagination. Workflow-file configuration becomes a required collection contract; renamed or deleted files must be corrected in `etl/repos.yaml` before collection can resume.

Warm same-window cycles still make one authorized conditional request per tracked workflow, but unchanged lists avoid their downstream parse, database, and jobs costs. Validators are persisted in PostgreSQL and created idempotently for existing Docker volumes because `pg/schema.sql` is otherwise applied only when a volume is initialized.
