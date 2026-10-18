# ADR-010: Collect tracked workflow runs at the GitHub API boundary

## Status

Implemented

## Context

The collector configured jobs and steps only for tracked workflows, but enumerated every repository workflow run through the repository-wide Actions runs endpoint first. High-volume repositories such as sglang saturated the endpoint's 1,000-result cap, forcing recursive time-window splitting over unrelated workflows and preventing timely collection of the workflows used by CI reports.

## Decision

When `etl/repos.yaml` configures workflow files for a repository, pass each configured filename directly to GitHub's workflow-specific runs endpoint. Continue using repository-wide run listing only for repositories without workflow rules.

Conditionally validate recent tracked-workflow collection windows with a durable ETag keyed by repository, workflow file, and exact window. A `304 Not Modified` response skips response parsing, persistence, and jobs collection for that workflow window. Store a new ETag only after the changed window's data and collection checkpoint succeed; incomplete work must not publish a validator that could hide missing writes on the next cycle. Do not store the first-page ETag of a saturated parent window because it cannot validate later pages; store only the recursively split, unsaturated child-window validators.

## Consequences

Raw runs and execution details collected for configured repositories are limited to tracked workflows. This matches CI efficiency and drilldown report scope and avoids unrelated-run API pagination. Workflow-file configuration becomes a required collection contract; renamed or deleted files must be corrected in `etl/repos.yaml` before collection can resume.

Warm same-window cycles still make one authorized conditional request per tracked workflow, but unchanged lists avoid their downstream parse, database, and jobs costs. Validators are persisted in PostgreSQL and created idempotently for existing Docker volumes because `pg/schema.sql` is otherwise applied only when a volume is initialized.

## Configuration constraints

### Current inventory: maintenance gate

Before adding or replacing a `workflows[].file` in `etl/repos.yaml`:

1. Verify the exact filename exists under `.github/workflows/` on the repository's default branch and is registered with GitHub Actions in `active` state. An entry retained only in Actions history is insufficient. Record the branch/commit and workflow identity in the PR.
2. Inspect triggers and jobs against the intended scope. Automatic PR analysis requires `pull_request` (including its branch/path filters); a manually dispatched run with a PR number is still `workflow_dispatch`. GPU/CPU comparison workflows remain valid inventory entries when deliberately selected.
3. Run `npm run validate:repos` for schema checks and `npm run validate:repos:online` for registered-filename matching. The online validator currently does **not** verify default-branch file existence, `active` state, triggers, or hardware use; steps 1–2 are manual checks. Authentication/rate-limit failures leave these checks unresolved, not passed.

### NPU scope: relevance versus consumption

An NPU image build is NPU-related, but does not establish NPU consumption. For resource/queue analysis, select runs with an actual NPU job identified by verified runner labels/resource metadata; count NPU job runtime and `job.started_at - job.created_at`. GPU and auxiliary jobs in a mixed workflow stay separate. Workflow E2E retains the selected run's full elapsed span. A filename, image name, or repository's NPU support alone is insufficient hardware evidence; unknown quantities remain unknown rather than inferred card counts.

### Renames, deletions, and historical recovery

Update the current inventory to an executable selector and retain stored historical runs/jobs. Treat a replacement as a new workflow identity unless continuity is verified; preserve original filenames in historical data. Backfill an old selector only after confirming its API identity is still queryable, and report unavailable history separately from legitimate empty windows. A 404, inaccessible attempt, or failed jobs page is an unresolved collection failure: retain the last durable checkpoint/validator and report its repo, workflow, window, and cause rather than recording an empty success. Resume other independent repositories through the existing scheduler; after correcting the selector, retry the failed scope. See [ADR-019](019-adaptive-job-pagination.md) for jobs-page recovery.
