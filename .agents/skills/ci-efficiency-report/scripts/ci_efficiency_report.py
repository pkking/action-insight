#!/usr/bin/env python3
"""
CI Efficiency Report Generator

Fetches GitHub PR and workflow data for a list of repositories,
computes CI efficiency metrics, and outputs an Excel report.

Usage:
    python ci_efficiency_report.py --repos owner/repo1 owner/repo2 --token YOUR_TOKEN --output report.xlsx [--days 90]
"""

import argparse
import math
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Any

import requests

try:
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    print("Error: openpyxl is required. Install with: pip install openpyxl")
    sys.exit(1)


GITHUB_API_BASE = "https://api.github.com"
PER_PAGE = 100
SESSION = requests.Session()


def github_request(token: str, path: str, params: dict | None = None) -> Any:
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    for attempt in range(3):
        try:
            resp = SESSION.get(f"{GITHUB_API_BASE}{path}", headers=headers, params=params, timeout=30)
            if resp.status_code == 404:
                return None
            if resp.status_code == 403 and attempt < 2:
                wait = int(resp.headers.get("Retry-After", "10"))
                print(f"  403, retrying after {wait}s...")
                time.sleep(wait)
                continue
            if resp.status_code == 422:
                print(f"  422: {resp.text[:200]}")
                return None
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            if attempt < 2:
                time.sleep(2)
                continue
            raise
    return None


def fetch_all_pages(token: str, path: str, params: dict | None = None) -> list:
    all_results = []
    page = 1
    while True:
        p = dict(params or {})
        p["per_page"] = PER_PAGE
        p["page"] = page
        data = github_request(token, path, p)
        if not data or not isinstance(data, list) or len(data) == 0:
            break
        all_results.extend(data)
        if len(data) < PER_PAGE:
            break
        page += 1
        time.sleep(0.2)
    return all_results


def fetch_all_pages_dict(token: str, path: str, params: dict | None = None, items_key: str = "workflow_runs") -> list:
    all_results = []
    page = 1
    while True:
        p = dict(params or {})
        p["per_page"] = PER_PAGE
        p["page"] = page
        data = github_request(token, path, p)
        if not data or not isinstance(data, dict):
            break
        items = data.get(items_key, [])
        if not items:
            break
        all_results.extend(items)
        if len(items) < PER_PAGE:
            break
        page += 1
        time.sleep(0.2)
    return all_results


def fetch_search_results(token: str, query: str, items_key: str = "items") -> list:
    all_results = []
    page = 1
    while True:
        data = github_request(token, "/search/issues", {
            "q": query, "sort": "created", "order": "desc",
            "per_page": PER_PAGE, "page": page,
        })
        if not data or not isinstance(data, dict):
            break
        items = data.get(items_key, [])
        if not items:
            break
        all_results.extend(items)
        if len(items) < PER_PAGE:
            break
        page += 1
        time.sleep(0.2)
    return all_results


def fetch_merged_prs(token: str, owner: str, repo: str, since_days: int = 90) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    since_str = cutoff.strftime("%Y-%m-%d")
    query = f"repo:{owner}/{repo} is:pr is:merged merged:>={since_str}"
    results = fetch_search_results(token, query)
    print(f"  Found {len(results)} merged PRs in last {since_days} days")
    return results


def parse_ts(ts_str: str) -> datetime:
    if not ts_str:
        return None
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))


def diff_minutes(start: str, end: str) -> float | None:
    s, e = parse_ts(start), parse_ts(end)
    if not s or not e:
        return None
    return (e - s).total_seconds() / 60.0


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    k = (len(sorted_vals) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    d0 = sorted_vals[int(f)] * (c - k)
    d1 = sorted_vals[int(c)] * (k - f)
    return d0 + d1


def compute_repo_metrics(token: str, owner: str, repo: str, since_days: int, max_prs: int = 0) -> dict:
    full_repo = f"{owner}/{repo}"
    print(f"\nProcessing {full_repo}...")

    prs = fetch_merged_prs(token, owner, repo, since_days)
    if max_prs > 0:
        prs = prs[:max_prs]
    if not prs:
        return {"Repository": full_repo, "统计PR数": 0}

    print(f"  Fetching PR details (head_sha)...")
    pr_list = []
    for i, pr in enumerate(prs):
        if (i + 1) % 50 == 0:
            print(f"  Fetching PR details {i+1}/{len(prs)}...")
        resp = requests.get(
            f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{pr['number']}",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
            timeout=15,
        )
        if resp.status_code == 200:
            detail = resp.json()
            pr_list.append({
                "number": pr["number"],
                "created_at": pr["created_at"],
                "merged_at": pr.get("closed_at") or detail.get("merged_at"),
                "head_sha": detail.get("head", {}).get("sha"),
            })
        time.sleep(0.2)

    pr_e2e_minutes = []
    pr_ci_e2e_minutes = []
    pr_ci_queue_lists = []
    pr_ci_exec_lists = []
    pr_review_minutes = []
    ci_e2e_under_60 = 0

    for idx, pr_info in enumerate(pr_list):
        pr_num = pr_info["number"]
        created_at = pr_info["created_at"]
        merged_at = pr_info["merged_at"]
        head_sha = pr_info.get("head_sha")

        pr_e2e = diff_minutes(created_at, merged_at)
        if pr_e2e is not None:
            pr_e2e_minutes.append(pr_e2e)

        runs = []
        if head_sha:
            runs = fetch_all_pages_dict(token, f"/repos/{owner}/{repo}/actions/runs", {
                "head_sha": head_sha, "status": "completed",
            })

        workflow_queue_durations = []
        workflow_exec_durations = []
        latest_ci_complete = None

        for run in runs:
            run_id = run["id"]
            run_updated = run.get("updated_at", "")

            jobs = fetch_all_pages_dict(token, f"/repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {"filter": "latest"}, "jobs")

            max_queue = 0.0
            max_exec = 0.0
            for job in jobs:
                queue = diff_minutes(job.get("created_at", ""), job.get("started_at", ""))
                if queue is not None and queue > max_queue:
                    max_queue = queue
                exec_dur = diff_minutes(job.get("started_at", ""), job.get("completed_at", ""))
                if exec_dur is not None and exec_dur > max_exec:
                    max_exec = exec_dur

            run_complete = parse_ts(run_updated)
            if run_complete and (latest_ci_complete is None or run_complete > latest_ci_complete):
                latest_ci_complete = run_complete

            workflow_queue_durations.append(round(max_queue, 1))
            workflow_exec_durations.append(round(max_exec, 1))

        if runs:
            ci_e2e = max((diff_minutes(r.get("created_at", ""), r.get("updated_at", "")) or 0 for r in runs), default=0)
            pr_ci_e2e_minutes.append(round(ci_e2e, 1))
            if ci_e2e < 60:
                ci_e2e_under_60 += 1

        pr_ci_queue_lists.append(workflow_queue_durations)
        pr_ci_exec_lists.append(workflow_exec_durations)

        if latest_ci_complete and merged_at:
            merged_dt = parse_ts(merged_at)
            review_min = (merged_dt - latest_ci_complete).total_seconds() / 60.0
            if review_min >= 0:
                pr_review_minutes.append(round(review_min, 1))

        if (idx + 1) % 10 == 0 or idx + 1 == len(pr_list):
            ci_count = sum(1 for lst in pr_ci_queue_lists if lst)
            print(f"  Processed {idx + 1}/{len(pr_list)} PRs ({ci_count} with CI)...")

    max_workflows = max((len(lst) for lst in pr_ci_queue_lists), default=0)

    result = {
        "Repository": full_repo,
        "PR E2E时长 P90(min)": round(percentile(pr_e2e_minutes, 0.9), 1),
        "CI E2E时长 P90(min)": round(percentile(pr_ci_e2e_minutes, 0.9), 1),
        "排队耗时 P90(min)": round(percentile(
            [max(lst) if lst else 0 for lst in pr_ci_queue_lists], 0.9
        ), 1),
        "CI执行时长 P90(min)": round(percentile(
            [max(lst) if lst else 0 for lst in pr_ci_exec_lists], 0.9
        ), 1),
        "PR检视时长 P90(min)": round(percentile(pr_review_minutes, 0.9), 1),
        "CI E2E达标率(%)": round(ci_e2e_under_60 / len(pr_ci_e2e_minutes) * 100, 1) if pr_ci_e2e_minutes else 0,
        "统计PR数": len(pr_list),
    }

    for i in range(max_workflows):
        col_name = f"CI排队时长-WF{i+1}(min)"
        values = [lst[i] for lst in pr_ci_queue_lists if i < len(lst)]
        result[col_name] = values

    for i in range(max_workflows):
        col_name = f"CI执行时长-WF{i+1}(min)"
        values = [lst[i] for lst in pr_ci_exec_lists if i < len(lst)]
        result[col_name] = values

    return result


def write_excel(results: list[dict], output_path: str):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "CI效率报告"

    main_columns = [
        "Repository",
        "PR E2E时长 P90(min)",
        "CI E2E时长 P90(min)",
        "排队耗时 P90(min)",
        "CI执行时长 P90(min)",
        "PR检视时长 P90(min)",
        "CI E2E达标率(%)",
        "统计PR数",
    ]

    queue_sub_cols = sorted([k for k in results[0].keys() if k.startswith("CI排队时长-WF")]) if results else []
    exec_sub_cols = sorted([k for k in results[0].keys() if k.startswith("CI执行时长-WF")]) if results else []
    all_columns = main_columns + queue_sub_cols + exec_sub_cols

    header_font = Font(name="Microsoft YaHei", bold=True, size=11, color="FFFFFF")
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    header_alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell_alignment = Alignment(horizontal="center", vertical="center")
    thin_border = Border(
        left=Side(style="thin"),
        right=Side(style="thin"),
        top=Side(style="thin"),
        bottom=Side(style="thin"),
    )

    for col_idx, col_name in enumerate(all_columns, 1):
        cell = ws.cell(row=1, column=col_idx, value=col_name)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border

    for row_idx, result in enumerate(results, 2):
        for col_idx, col_name in enumerate(all_columns, 1):
            value = result.get(col_name, "")
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.alignment = cell_alignment
            cell.border = thin_border

            if col_name == "CI E2E达标率(%)" and isinstance(value, (int, float)):
                if value >= 80:
                    cell.fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
                elif value >= 50:
                    cell.fill = PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid")
                else:
                    cell.fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")

    for col_idx in range(1, len(all_columns) + 1):
        max_len = 0
        col_letter = get_column_letter(col_idx)
        for row in ws.iter_rows(min_col=col_idx, max_col=col_idx):
            for cell in row:
                if cell.value:
                    max_len = max(max_len, len(str(cell.value)))
        ws.column_dimensions[col_letter].width = min(max_len + 4, 30)

    ws.freeze_panes = "A2"

    wb.save(output_path)
    print(f"\nReport saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate CI efficiency report for GitHub repositories")
    parser.add_argument("--repos", nargs="+", required=True, help="List of org/repo")
    parser.add_argument("--token", required=True, help="GitHub PAT")
    parser.add_argument("--output", default="ci_efficiency_report.xlsx", help="Output Excel file path")
    parser.add_argument("--days", type=int, default=90, help="Number of days to look back (default: 90)")
    parser.add_argument("--max-prs", type=int, default=0, help="Max PRs per repo (0=unlimited)")
    args = parser.parse_args()

    results = []
    for repo_str in args.repos:
        if "/" not in repo_str:
            print(f"Skipping invalid repo format: {repo_str} (expected org/repo)")
            continue
        owner, repo = repo_str.split("/", 1)
        metrics = compute_repo_metrics(args.token, owner, repo, args.days, args.max_prs)
        results.append(metrics)

    if not results:
        print("No valid repositories to process.")
        sys.exit(1)

    write_excel(results, args.output)


if __name__ == "__main__":
    main()
