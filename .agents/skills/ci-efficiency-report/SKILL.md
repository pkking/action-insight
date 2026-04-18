---
name: ci-efficiency-report
description: Generate an Excel report analyzing CI efficiency metrics across multiple GitHub repositories. Use this skill whenever the user wants to analyze CI/CD performance, measure PR turnaround times, track workflow queue durations, calculate CI SLA compliance, or generate efficiency reports for GitHub repositories. Also use when the user mentions "CI效率", "CI efficiency", "PR时长", "workflow timing", "queue duration report", "CI达标率", or asks to compare CI performance across repos. Make sure to use this skill even if the user just says "统计一下这几个repo的CI情况" or "帮我看看CI效率".
---

# CI Efficiency Report

Generates an Excel report with CI efficiency metrics for a list of GitHub repositories (org/repo format). One row per repo, with aggregated P90 statistics and per-workflow breakdowns.

## Prerequisites

The bundled Python script requires `openpyxl`. Install it first if not present:

```bash
pip install openpyxl
```

A GitHub Personal Access Token (PAT) with `repo` scope is required. Set it as `GITHUB_TOKEN` or pass via `--token`.

## How it works

The script (`scripts/ci_efficiency_report.py`) does the following for each repository:

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

### Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `--repos` | Yes | - | Space-separated list of org/repo |
| `--token` | Yes | - | GitHub PAT with repo scope |
| `--output` | No | `ci_efficiency_report.xlsx` | Output file path |
| `--days` | No | `90` | Lookback window in days |

## Rate limiting

The script handles GitHub API rate limits automatically:
- Checks `X-RateLimit-Remaining` headers and waits if exhausted
- Retries on 403 with `Retry-After` header
- Uses 0.5s polite delay between paginated requests
- Supports up to 5,000 requests/hour (PAT auth)

For large repos with thousands of PRs, consider narrowing `--days` to reduce API calls.

## Output format

The Excel file contains one sheet "CI效率报告" with:
- Frozen header row
- Color-coded达标率 cells (green ≥80%, yellow ≥50%, red <50%)
- Auto-sized columns
- Per-workflow sub-columns for queue and execution breakdowns
