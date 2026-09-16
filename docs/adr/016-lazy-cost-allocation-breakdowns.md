# ADR-016: Lazy Cost allocation breakdowns

**Status**: Accepted  
**Date**: 2026-09-16

## Context

The Cost table is a paged, capped summary grouped by repository, workflow, ref, and resource model. A workflow/resource pie chart must describe the complete active filter window, not only the visible page or the 500-row display cap. Sending every raw job to the browser would violate ADR-008's bounded dashboard payload.

## Decision

Cost allocation pies use two lazy, repository-scoped read-model endpoints over the same attempt-scoped `workflow_jobs` data and Machine-Hour definition as the Cost tab:

1. Selecting a Cost table workflow fetches its Machine-Hours grouped by resource model.
2. Selecting a resource-model slice fetches that model's Machine-Hours grouped by workflow.

Both requests retain the current date window and selected repository. Only attributable jobs (non-negative runtime and positive resource count) contribute. Unknown-cost jobs remain excluded, matching the existing Cost cards and table.

## Consequences

- The initial Cost payload remains bounded and unchanged by pie drill-down volume.
- Pie totals remain complete for the selected repository/date window despite table pagination or truncation.
- Opening a breakdown adds one local PostgreSQL query but makes no GitHub API request.
- In an all-repositories view, selecting a table row scopes the modal to that row's repository so workflow identity is unambiguous.
