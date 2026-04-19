---
name: ci-efficiency-report
description: Generate an Excel report analyzing CI efficiency metrics across multiple GitHub repositories. Use this skill whenever the user wants to analyze CI/CD performance, measure PR turnaround times, track workflow queue durations, calculate CI SLA compliance, or generate efficiency reports for GitHub repositories. Also use when the user mentions "CI效率", "CI efficiency", "PR时长", "workflow timing", "queue duration report", "CI达标率", or asks to compare CI performance across repos. Make sure to use this skill even if the user just says "统计一下这几个repo的CI情况" or "帮我看看CI效率".
---

# CI Efficiency Report

Generates an Excel report with CI efficiency metrics for a list of GitHub repositories (org/repo format). One row per repo, with aggregated P90 statistics and per-workflow breakdowns.

This skill should support two report modes for single-repo deep dives:

1. **`monthly_summary`**: a management-facing monthly CI submission experience report
2. **`daily_diagnostic`**: a technical-team-facing daily CI problem analysis report

Both modes should share the same underlying data collection and drill-down capability, but differ in how the output is organized.

This skill enhancement must stay scoped to `.agents/skills/ci-efficiency-report/` and its report artifacts. It must not change the repository's frontend behavior under `src/` or the ETL behavior under `etl/`.

For single-repo deep dives, do not stop at the top-line P90 table. Also produce:

1. A **CI E2E distribution table** that buckets PRs into:
   - `CI < 60m`
   - `60-120m`
   - `120-240m`
   - `> 240m`
2. A **workflow drag ranking** that aggregates by workflow name and highlights which workflows most often dominate slow PRs in the selected window.
3. A **PR-oriented layered CI breakdown table** that drills down from the PR perspective:
   - first: which workflows are the most time-consuming in the selected period
   - then: within the slowest workflows, which jobs are the most time-consuming
   - finally: within the slowest jobs, which steps are the most time-consuming
   - every layer must include both duration metrics and run-count metrics
4. A **longest-job summary** that identifies which job is the slowest in the selected period after combining both runtime length and run frequency.
5. A **raw-data appendix** that includes the detailed records used to build the aggregates:
   - one dedicated worksheet for workflow-level raw rows
   - one dedicated worksheet for job-level raw rows
   - one dedicated worksheet for step-level raw rows
   - these raw tables must preserve enough identifiers and timestamps for a reader to trace any aggregate back to the original workflow/job/step execution records

For `daily_diagnostic`, the report should additionally start with a **current problem list** instead of a broad management summary. That problem list should prioritize:

- currently slow workflows
- currently slow jobs
- currently slow steps
- frequent drag items
- candidates for follow-up tracking

## Prerequisites

The bundled Python script requires `openpyxl`. Install it first if not present:

```bash
pip install openpyxl
```

A GitHub Personal Access Token (PAT) with `repo` scope is required only when GitHub API backfill is needed. Provide it as `GITHUB_TOKEN` or pass via `--token`.

## Data source policy

This skill must **not assume** local data is sufficient by default.

When fulfilling a report request, use this decision order:

1. **Check local repository data first**
   - Inspect `data/<owner>/<repo>/` and related local report artifacts if they exist.
   - Confirm the local files actually cover the user-requested time window.
   - Confirm the local files contain the fields needed for the requested report depth.
     Examples:
     - PR-oriented monthly summary needs reliable PR mapping and merged PR timing fields.
     - workflow/job/step drill-down needs corresponding run/job/step timing fields.
2. **Use local data only when coverage is sufficient**
   - If local data fully covers the requested window and required metrics, generate the report directly from local data.
   - In the final answer, state the actual local coverage window used.
3. **Do not silently downgrade when local data is incomplete**
   - If local data is missing entirely, partially covers the requested dates, or lacks required fields for the requested metrics, do not pretend the report is complete.
   - Explicitly tell the user what is missing:
     - missing repo data
     - missing dates in the requested window
     - missing PR mapping
     - missing step timing data
     - other metric-specific gaps
4. **Prompt for GitHub token when API backfill is needed**
   - If local data is insufficient and fresh or missing data must be fetched from GitHub, explicitly ask the user to provide a GitHub token.
   - Accept either:
     - `GITHUB_TOKEN` in the environment
     - a `--token` value passed to the script
   - The prompt should be short and direct. Example:
     - `本地数据不足以覆盖 2026-04-01 到 2026-04-30。请提供具有 repo scope 的 GITHUB_TOKEN，我再通过 GitHub API 补齐并生成完整报告。`
5. **Only use API collection after token is available**
   - Once the user provides a valid token, fetch the missing data via GitHub API and then generate the report.
   - Prefer local data + API backfill for the uncovered portion rather than discarding usable local data.

If the requested report can only be partially answered from local data and the user does not provide a token, the response must clearly label the result as a **partial report** and enumerate the missing parts.

## Required execution behavior

Before generating the report, always perform and communicate these checks:

1. Normalize repository names to `owner/repo` format.
2. Resolve the exact requested time window.
   - For relative requests like "4月", use explicit dates in the response.
   - If today is mid-month, treat a monthly request as month-to-date unless the user explicitly asks for a full historical month that has already completed.
3. Check local data coverage per repository.
4. Decide whether each repository is:
   - `local_complete`
   - `local_partial_requires_token`
   - `local_missing_requires_token`
5. If any repository needs API backfill, stop and ask the user for a token before claiming a complete report.

Do not hide this decision behind generic wording like "data unavailable". Be concrete about which repository and which dates or metrics are missing.

## How it works

The script (`scripts/ci_efficiency_report.py`) does the following for each repository after data-source resolution is complete:

1. **Fetches merged PRs** within the lookback window (default 90 days) via `GET /repos/{owner}/{repo}/pulls`
2. **For each PR**, finds associated workflow runs via `GET /repos/{owner}/{repo}/actions/runs`
3. **For each run**, fetches jobs via `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
4. **Computes timing metrics** from timestamps:
   - Queue duration = `started_at - created_at` (time waiting for a runner)
   - Execution duration = `completed_at - started_at` (actual run time)
   - PR E2E = `merged_at - created_at`
   - PR review time = `merged_at - latest CI completion`
5. **Aggregates** P90 statistics and SLA rates per repo
6. **Writes** a formatted Excel file with color-coded cells

For single-repo analysis, add these post-processing passes:

7. **Bucket PRs by CI E2E duration** and report PR count plus percentage for each bucket: `<60m`, `60-120m`, `120-240m`, `>240m`
8. **Aggregate slow-path workflows by workflow name** to identify which workflows are most responsible for long-tail CI duration
9. **Build a layered CI drill-down table from the PR perspective**:
   - rank workflows by aggregated duration impact in the selected period
   - for the top workflows, rank jobs by aggregated duration impact
   - for the top jobs, rank steps by aggregated duration impact
   - attach run counts at workflow, job, and step levels so the output distinguishes "slow because rare and huge" from "slow because frequent"
10. **Build a longest-job ranking for the selected period** that highlights:
   - max observed runtime
   - average runtime
   - total cumulative runtime
   - run count
   - whether the job is a long-tail outlier or a frequent drag on overall CI time
11. **For daily diagnostics, build a current-problems list** that:
   - ranks the most actionable problems in the selected short time window
   - prioritizes current hotspots over broad monthly summary statistics
   - distinguishes between current issue, likely recurring issue, and probable outlier when enough evidence exists
12. **Write raw detail tables into Excel as first-class outputs, not hidden scratch data**:
   - a workflow raw table with one row per workflow run in scope
   - a job raw table with one row per job run in scope
   - a step raw table with one row per step record in scope
   - if step-level coverage is partial, still output the available step raw rows and clearly mark coverage limitations in both the workbook and final response

## Raw data requirements

In addition to summary and ranking tables, the generated workbook must contain the original detail rows used for analysis so the user can inspect every workflow, job, and step in the selected window.

Minimum workbook structure for a single-repo deep dive:

1. A summary-oriented sheet for management or diagnostics
2. A statistics/drill-down sheet with aggregated workflow/job/step rankings
3. A `Workflow Raw` sheet
4. A `Job Raw` sheet
5. A `Step Raw` sheet

The raw worksheets should not be reduced to only top-N rows. They should contain **all available rows in scope** for the selected repository and time window, subject only to source-data availability.

Recommended minimum columns:

### `Workflow Raw`

- repository
- pr_number
- pr_title
- pr_url
- pr_created_at
- pr_merged_at
- pr_e2e_minutes
- ci_e2e_minutes
- workflow_run_id
- workflow_run_number
- workflow_run_attempt
- workflow_name
- workflow_status
- workflow_conclusion
- branch
- head_sha
- event
- actor
- created_at
- started_at
- completed_at
- queue_minutes
- execution_minutes
- run_e2e_minutes
- workflow_url

### `Job Raw`

- repository
- pr_number
- pr_title
- pr_url
- pr_created_at
- pr_merged_at
- workflow_run_id
- workflow_run_number
- workflow_run_attempt
- workflow_name
- branch
- head_sha
- event
- actor
- job_id
- job_name
- check_run_url
- runner_id
- runner_name
- runner_os
- runner_arch
- runner_group
- runner_labels
- job_matrix
- job_status
- job_conclusion
- created_at
- started_at
- completed_at
- queue_minutes
- execution_minutes
- html_url

### `Step Raw`

- repository
- pr_number
- pr_title
- pr_url
- pr_created_at
- pr_merged_at
- workflow_run_id
- workflow_run_number
- workflow_run_attempt
- workflow_name
- job_id
- job_name
- step_number
- step_name
- step_status
- step_conclusion
- started_at
- completed_at
- execution_minutes
- raw_step_index
- step_timing_missing

If some fields are unavailable from the source data, keep the worksheet and include the rows anyway, leaving missing values blank rather than omitting the table.

## Metric definitions

| Column | Definition |
|---|---|
| PR E2E时长 P90(min) | P90 of (merged_at - created_at) across all merged PRs |
| CI E2E时长 P90(min) | P90 of per-PR max workflow run duration |
| 排队耗时 P90(min) | P90 of per-workflow max job queue duration |
| CI执行时长 P90(min) | P90 of per-workflow max job execution duration |
| PR检视时长 P90(min) | P90 of (merged_at - latest CI completion timestamp) |
| CI E2E达标率(%) | % of PRs where CI E2E < 60 minutes |
| CI排队时长-WF*N*(min) | Per-workflow queue duration breakdown (column per workflow) |
| CI执行时长-WF*N*(min) | Per-workflow execution duration breakdown (column per workflow) |
| 统计PR数 | Number of merged PRs analyzed |

## Usage

```bash
python scripts/ci_efficiency_report.py \
  --repos org/repo1 org/repo2 org/repo3 \
  --token YOUR_GITHUB_TOKEN \
  --output ci_report.xlsx \
  --days 90
```

For a strict monthly or custom-window report, prefer explicit dates:

```bash
python scripts/ci_efficiency_report.py \
  --repos org/repo1 \
  --token YOUR_GITHUB_TOKEN \
  --output ci_report.xlsx \
  --report-mode monthly_summary \
  --start-date 2026-04-01 \
  --end-date 2026-04-30
```

For a daily technical diagnostic:

```bash
python scripts/ci_efficiency_report.py \
  --repos org/repo1 \
  --token YOUR_GITHUB_TOKEN \
  --output ci_report.xlsx \
  --report-mode daily_diagnostic \
  --start-date 2026-04-19 \
  --end-date 2026-04-19
```

### Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `--repos` | Yes | - | Space-separated list of org/repo |
| `--token` | No | - | GitHub PAT with repo scope; required when local data is missing or incomplete and API backfill is needed |
| `--output` | No | `ci_efficiency_report.xlsx` | Output file path |
| `--report-mode` | No | `monthly_summary` | Report mode: `monthly_summary` or `daily_diagnostic` |
| `--days` | No | `90` | Lookback window in days |
| `--start-date` | No | - | Explicit start date in `YYYY-MM-DD` format |
| `--end-date` | No | - | Explicit end date in `YYYY-MM-DD` format |

## Rate limiting

The script handles GitHub API rate limits automatically:
- Checks `X-RateLimit-Remaining` headers and waits if exhausted
- Retries on 403 with `Retry-After` header
- Uses 0.5s polite delay between paginated requests
- Supports up to 5,000 requests/hour (PAT auth)

For large repos with thousands of PRs, consider narrowing `--days` to reduce API calls.

When local data already covers part of the requested window, prefer fetching only the missing portion instead of re-fetching everything.

## Output format

The Excel file should preserve repo-level compatibility while supporting report-mode-specific outputs:
- A legacy summary sheet `CI效率报告` for flat repo-level metrics
- For `monthly_summary`:
  - a `Management Summary` sheet
  - a `Diagnostic Appendix` sheet
  - a `Workflow Raw` sheet
  - a `Job Raw` sheet
  - a `Step Raw` sheet
- For `daily_diagnostic`:
  - a daily current-problems sheet
  - a technical drill-down sheet
  - a `Workflow Raw` sheet
  - a `Job Raw` sheet
  - a `Step Raw` sheet
- Frozen header rows
- Color-coded达标率 cells (green ≥80%, yellow ≥50%, red <50%)
- Auto-sized columns

The raw-data sheets are mandatory whenever the underlying data exists. They are intended to let the reader inspect every workflow/job/step row behind the summary metrics, not just the ranked aggregates.

When the user asks for a monthly report, the final answer should also include:

- A CI E2E distribution table over PRs using the four standard buckets: `<60m`, `60-120m`, `120-240m`, `>240m`
- The PR count and percentage in each bucket
- A workflow-name aggregation showing which workflows appear most often among the slowest PRs or contribute the largest run durations
- A layered CI breakdown table from the PR perspective: `workflow -> job -> step`
- Run-count columns at each layer so the reader can see both cost and frequency
- A dedicated longest-job summary for the selected period, combining runtime and occurrence count
- Three separate raw-data tables or sheets containing all available workflow, job, and step records in the selected window
- A short interpretation of whether the bottleneck is primarily queueing, execution time, or a small set of heavyweight workflows
- A note stating whether the report is based on:
  - fully local data
  - local data plus GitHub API backfill
  - partial local-only data because token-backed backfill was not provided

When the user asks for a daily technical analysis, the final answer should instead prioritize:

- A current-problems list for the selected window
- The slowest workflows, jobs, and steps in that window
- Run-count-aware ranking so the team can distinguish frequent drag from one-off outliers
- A short interpretation of what should be fixed first vs what should keep being tracked
- A clear data-completeness note when local coverage is partial or token-backed backfill was not available
