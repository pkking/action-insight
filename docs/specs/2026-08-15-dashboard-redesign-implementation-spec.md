# Dashboard Redesign Production Implementation Spec

**Date**: 2026-08-15  
**Status**: Draft — ready for implementation review  
**Design source**: `prototype/dashboard-redesign.html` at commit `39e7887980086e4638387eaad46f6dc58498daae`  
**Architecture**: [ADR-008](../adr/008-dashboard-read-models.md)

## 1. Objective

Replace the current mixed overview/detail homepage with the approved five-tab analysis dashboard: **PR / Cost / Workflow / Job / Queue**. Preserve the prototype's visual hierarchy and interactions while using real attempt-scoped PostgreSQL data, explicit metric definitions, and bounded payloads.

This document fixes implementation and data contracts. The prototype remains the visual source of truth; mock values and its inline JavaScript are not production logic.

## 2. Scope and rollout

Deliver incrementally:

1. **Shared shell + PR tab** — five-tab navigation, fixed filter toolbar, metric cards, chart/table layout, pagination, loading/empty/error states, 500-observation warning, and PR → workflow/job → eligible-step drill-down.
2. **Cost tab** — Machine-Hour cards, daily repository trend, workflow/resource detail.
3. **Workflow tab** — attempt metrics, resource-expanded summaries, and lazy run stream.
4. **Job + Queue tabs** — job summaries/run stream and queue analysis by Resource Model.
5. **Closeout** — remove superseded homepage paths only after parity checks; retain reusable metric tooltip/date/query helpers.

Do not block slice 1 on aggregate tables, new ETL, or complete historical runner metadata. Missing data is surfaced, not invented.

## 3. Shared experience

### Layout

Every tab uses the same order:

1. toolbar;
2. five metric cards;
3. trend/observation chart;
4. paged detail table;
5. metric-definition footer and data-quality/truncation notices.

The toolbar location does not move between tabs. It contains a repository selector (`All repositories` plus one Tracked Repository) and a date range selector. PR defaults to the latest 1 day; the other tabs default to 14 days. Tab state may be represented in URL search parameters so reload/back navigation is stable.

Runner labels and Resource Model are collection/secondary filters, never a sixth top-level dashboard dimension. Queue may add a Resource Model selector beside the repository selector.

### Common states

- **Loading**: retain the section shape with an explicit loading message/skeleton; never show stale values as current.
- **Empty**: explain which filter has no valid samples.
- **Partial**: show missing PR artifacts, incomplete PR resolution, legacy fallback, invalid timing, missing resource metadata, and unavailable step samples separately.
- **Error**: one repository failure must not hide successful repositories; list failed repositories.
- **Truncated**: state `showing latest 500 of N observations` and suggest narrowing the date range.

### Common limits and ordering

- Filters apply before aggregation and limiting.
- Cards and total counts use the full filtered population.
- Charts and detail observations use at most the newest 500 samples, ordered by the tab's date anchor descending before pagination.
- Daily trend series are ordered ascending by UTC date.
- Default detail page size is 20; changing pages does not recompute cards.
- Clicking a chart observation selects/highlights the matching table row and moves to its page. Clicking a PR observation also opens its drill-down.

## 4. Canonical metric rules

| Term | Definition | Eligibility/date anchor |
|---|---|---|
| PR Queue Duration | PR `created_at` → first tracked CI `ci_started_at` | Valid non-negative sample; PR tab anchored by `merged_at` |
| PR CI Runtime | First tracked CI start → last tracked CI completion | Valid non-negative sample |
| PR Review Duration | Last tracked CI completion → PR merge | Valid non-negative sample; negative values are not clamped into normal review metrics |
| PR End-to-End Duration | PR Queue Duration + PR CI Runtime + PR Review Duration | Merged PR with all three valid parts |
| Forced Merge Indicator | PR merged before tracked CI completed | Requires both timestamps; partial CI history excluded |
| Workflow Total Duration | Workflow Queue Duration + Workflow Runtime | Successful samples for percentiles; all terminal attempts for outcome counts |
| Job Total Duration | Job Queue Duration + Job Runtime | Successful samples for percentiles; all terminal jobs for outcome counts |
| Machine-Hours | `Job Runtime seconds × Resource Count ÷ 3600` | Positive Resource Count and valid Job Runtime only |
| Success Rate | Successful terminal samples ÷ all terminal samples | Non-terminal samples excluded from denominator |

P50/P90 use the repository's existing percentile convention. Invalid timing samples are excluded and counted. Null/unknown values render as unavailable, never zero.

## 5. Tab contracts

### 5.1 PR

**Cards**
- PR End-to-End Duration: average, P50, P90.
- PR CI Runtime: average, P50, P90.
- PR Review Duration: average, P50, P90.
- Forced Merge Rate: forced/eligible merged PRs.
- Merged PR count in range.

**Chart**
- One stacked bar per displayed PR: queue + CI runtime + review.
- PR count is a daily line on a secondary axis.
- The chart and table share PR identity `(repo, pr_number)`.

**Table**
- Repository, PR number/link, title, queue, CI runtime, review, merge state.
- Expanding a PR lazily loads tracked workflow attempts/jobs.
- The drill-down first summarizes Machine-Hours by Resource Model, then lists job name, Resource Model, Resource Count, queue, runtime, Machine-Hours, and conclusion.
- Expanding a job lists persisted Eligible Step Data: number, name, runtime, and conclusion. If steps were not eligible/collected, say so explicitly.

### 5.2 Cost

**Cards**
- Total Machine-Hours.
- Machine-Hours per merged PR with at least one attributable job.
- highest-cost repository (or workflow when one repository is selected).
- daily average Machine-Hours.
- contributing repository count (or PR count for one repository).

**Chart**
- Daily Machine-Hours per repository; selected repository is emphasized.

**Table**
- Repository, Workflow Identity, Resource Model, average Workflow Total Duration, attempt count, success count, failure rate, Machine-Hours, and share of filtered total.
- A workflow spanning resources produces one row per Resource Model; repeated workflow/repository cells may be visually merged.
- Unknown-cost sample count is always available in the response and shown when non-zero.

### 5.3 Workflow

**Cards**
- total workflow attempts, P50/P90 Workflow Total Duration, Workflow Success Rate, contributing repository count.
- For one repository, the fifth card may show highest-Machine-Hour workflow.

**Chart**
- All repositories: daily attempt count per repository.
- One repository: daily attempt count per Workflow Identity.

**Table and drill-down**
- Repository, Workflow Identity, Resource Model, average Workflow Total Duration, attempt count, success count, failure rate, Machine-Hours.
- Group by `(repo, workflow_file, workflow_ref, resource_model)`; do not merge same display names from different files/refs.
- Expanding a workflow lazily loads attempts with run/attempt identity, queue, runtime, date, and conclusion, plus the stacked queue/runtime chart.

### 5.4 Job

**Cards**
- total jobs, P50/P90 Job Total Duration, Job Success Rate, contributing repository count.
- For one repository, the fifth card may show highest-Machine-Hour job.

**Chart**
- All repositories: daily job count per repository.
- One repository: daily count per job grouping.

**Table and drill-down**
- Repository, Workflow Identity, job name, Resource Model, average Job Total Duration, execution count, success count, failure rate, Machine-Hours.
- Group by `(repo, workflow_file, workflow_ref, job_name, resource_model)` to avoid conflating equal job names in different workflows.
- Expanding a row lazily loads Job Attempt Identity, queue, runtime, Resource Model, date, and conclusion, plus the stacked queue/runtime chart.

### 5.5 Queue

**Cards**
- Job Queue Duration P50/P90, maximum valid queue duration, share over one hour, distinct Resource Model count.

**Chart**
- Daily Job Queue Duration trend split by Resource Model; Resource Model is filterable.
- The statistic shown by each daily series is P90, matching the table's primary queue metric.

**Table**
- Repository, Workflow Identity, job name, Resource Model, queue P90, execution count, and Job Success Rate.
- Repository filtering remains available; Resource Model is secondary.

## 6. Server read-model interface

Use one internal query module as the seam. Exact filenames may follow repository conventions, but callers should not assemble SQL or recompute metrics.

```ts
type DashboardTab = 'pr' | 'cost' | 'workflow' | 'job' | 'queue';

type DashboardQuery = {
  tab: DashboardTab;
  startDate: string; // inclusive UTC yyyy-mm-dd
  endDate: string;   // inclusive UTC yyyy-mm-dd
  repoKey?: string;  // absent means all tracked repositories
  resourceModel?: string; // queue secondary filter only
  page: number;
  pageSize: 20;
  observationLimit: 500;
};

type DashboardResult<TCards, TSeries, TRow> = {
  cards: TCards;
  series: TSeries[];
  rows: TRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  displayedObservationCount: number;
  truncated: boolean;
  quality: {
    invalidTimingSamples: number;
    unknownResourceSamples: number;
    partialHistorySamples: number;
    legacyFallbackSamples: number;
  };
};
```

Requirements:
- Validate date order, page bounds, tab, repository membership, and Resource Model input at the server seam.
- Parameterize all SQL.
- Read only Tracked Workflows/jobs for workflow, job, queue, and cost metrics.
- Keep attempt identity in every drill-down key.
- Cache identical read queries using the existing server/cache approach; no GitHub API call is allowed on dashboard reads.
- Fetch drill-down detail through a separate bounded query keyed by stable domain identity, only after expansion.
- Do not expose raw `githubPayload` in dashboard responses.

## 7. Existing support and gaps

### Reusable now
- `pr_metrics` contains PR lifecycle timestamps and summary durations.
- `pr_workflow_attempts` links PRs to reruns without collapsing attempts.
- `workflow_attempts` contains tracked status, queue/runtime/total duration, workflow file/ref, and attempt identity.
- `workflow_jobs` contains attempt-scoped timing plus Resource Model/Count.
- `workflow_steps` supports eligible-step drill-down.
- Existing date controls, metric tooltip, Recharts, dark mode, repo options, partial-repository handling, and PR detail fetching can be reused.

### Must be added or corrected
- Current homepage loading exposes PR indexes but not coherent tab read models.
- Current PR attempt detail query omits `workflow_jobs.resource_model`, `resource_count`, and runner metadata from mapped jobs.
- Current generic run queries omit resource fields in both legacy and attempt-scoped job selects.
- No server aggregation currently produces Cost, Workflow, Job, or Queue cards/series/tables.
- Current `DashboardClient.tsx` mixes query parsing, aggregation, and several detail modes; production slices should move metric computation behind the server seam rather than extend that file with more local reducers.
- Historical rows without attempt/resource metadata require visible partial/unknown counts; recollection is a separate operational task, not a dashboard read.

No PostgreSQL schema change is required for the initial slice. If implementation discovers a missing field rather than a missing select/mapping, update ADR-008 before adding storage.

## 8. Verification contract

Each slice must include the smallest tests that prove:

- date/repository/resource filters are applied before aggregation;
- reruns remain distinct by Workflow Attempt Identity;
- invalid and missing timing/resource values are excluded and counted;
- Machine-Hours exclude queue and do not assume missing Resource Count equals one;
- successful-only percentile and terminal-only rate denominators are correct;
- full-range cards remain stable when detail observations cross 500;
- truncation metadata and latest-500 ordering are correct;
- chart selection reaches the matching paged table row;
- loading, empty, partial, and error states render in light and dark themes;
- PR/job/workflow drill-down requests are lazy and bounded.

For `src/**` changes run `npm run lint` and `npm test`. ETL changes are out of scope; if later required, also run the repository's ETL validation commands. Validate query plans against representative retained data before adding indexes or pre-aggregation.

## 9. Explicit non-goals

- No runner telemetry, device utilization, monetary pricing, or cloud-billing estimate.
- No new GitHub collection call from a dashboard request.
- No weekly/monthly chart granularity in the first rollout.
- No configurable metric-card builder or generic dashboard framework.
- No persistence of client selections beyond URL state.
- No claim that absent Eligible Step Data means a workflow had no steps.
