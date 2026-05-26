#!/usr/bin/env python3
"""Test case counter for CI Efficiency Report.

Counts test cases executed by CI jobs, classified by hardware type
(Ascend vs NVIDIA) based on runner labels, directory paths, and job names.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    requests = None

try:
    import yaml
except ImportError:
    yaml = None


DEFAULT_CACHE_DIR = os.environ.get("CI_REPORT_CACHE_DIR", os.path.expanduser("~/.ci-report-cache"))

ASCEND_LABELS = {"npu", "ascend", "cann", "npu-arm"}
NVIDIA_LABELS = {"cuda", "gpu", "nvidia"}

ASCEND_DIRS = {"tests/ascend", "tests/npu", "tests/cann"}
NVIDIA_DIRS = {"tests/cuda", "tests/gpu", "tests/nvidia"}

ASCEND_NAME_PATTERNS = re.compile(r"(ascend|npu|cann)", re.IGNORECASE)
NVIDIA_NAME_PATTERNS = re.compile(r"(cuda|gpu|nvidia)", re.IGNORECASE)

TEST_FILE_PATTERNS = ["test_*.py", "*_test.py"]
TEST_DIR_NAMES = {"tests", "test"}

TEST_COMMAND_PATTERNS = [
    re.compile(r"pytest\s+(.+?)(?:\s*--|\s*$|\s*&&|\s*\|)", re.MULTILINE),
    re.compile(r"python\s+-m\s+pytest\s+(.+?)(?:\s*--|\s*$|\s*&&|\s*\|)", re.MULTILINE),
    re.compile(r"python\s+-m\s+unittest\s+(.+?)(?:\s*$|\s*&&|\s*\|)", re.MULTILINE),
    re.compile(r"python\s+(\S*test\S*\.py)", re.MULTILINE),
]


def clone_or_update_repo(repo: str, cache_dir: str = DEFAULT_CACHE_DIR) -> str:
    """Clone or git pull a repo, return local path."""
    local_path = os.path.join(cache_dir, repo.replace("/", "_"))

    if os.path.isdir(os.path.join(local_path, ".git")):
        subprocess.run(
            ["git", "pull", "--ff-only"],
            cwd=local_path,
            capture_output=True,
            timeout=120,
        )
    else:
        os.makedirs(cache_dir, exist_ok=True)
        url = f"https://github.com/{repo}.git"
        subprocess.run(
            ["git", "clone", "--depth", "1", url, local_path],
            capture_output=True,
            timeout=300,
        )

    return local_path


def classify_hardware_from_runner_labels(labels: list[str]) -> str | None:
    """Classify hardware type based on runner labels.

    Returns "ascend", "nvidia", or None.
    """
    normalized = {label.lower() for label in labels}

    if normalized & ASCEND_LABELS:
        return "ascend"

    if normalized & NVIDIA_LABELS:
        return "nvidia"

    if "x86_64" in normalized and "cuda" in normalized:
        return "nvidia"

    return None


def classify_hardware_from_directory(path: str) -> str | None:
    """Classify hardware type based on directory path."""
    normalized = path.lower().replace("\\", "/")

    for prefix in ASCEND_DIRS:
        if normalized.startswith(prefix + "/") or f"/{prefix}/" in normalized:
            return "ascend"

    for prefix in NVIDIA_DIRS:
        if normalized.startswith(prefix + "/") or f"/{prefix}/" in normalized:
            return "nvidia"

    return None


def classify_hardware_from_job_name(job_name: str) -> str | None:
    """Classify hardware type based on job name."""
    if ASCEND_NAME_PATTERNS.search(job_name):
        return "ascend"
    if NVIDIA_NAME_PATTERNS.search(job_name):
        return "nvidia"
    return None


def parse_workflow_to_test_mapping(repo_path: str) -> dict:
    """Parse all .github/workflows/*.yml files, map job names to test file patterns.

    Returns dict mapping workflow_name -> job_name -> {
        "runner_labels": list[str],
        "test_patterns": list[str],
        "test_dirs": list[str],
        "hardware_hint": str | None,
        "steps": list[dict],
    }
    """
    if yaml is None:
        return {}

    workflow_dir = os.path.join(repo_path, ".github", "workflows")
    if not os.path.isdir(workflow_dir):
        return {}

    mapping: dict[str, dict[str, Any]] = {}

    for wf_file in glob.glob(os.path.join(workflow_dir, "*.yml")) + \
                   glob.glob(os.path.join(workflow_dir, "*.yaml")):
        try:
            with open(wf_file, "r") as f:
                wf_data = yaml.safe_load(f)
        except Exception:
            continue

        if not isinstance(wf_data, dict):
            continue

        workflow_name = wf_data.get("name", Path(wf_file).stem)
        jobs = wf_data.get("jobs", {})
        if not isinstance(jobs, dict):
            continue

        workflow_mapping: dict[str, Any] = {}

        for job_name, job_data in jobs.items():
            if not isinstance(job_data, dict):
                continue

            runner_labels = _extract_runner_labels(job_data)
            hardware_hint = classify_hardware_from_runner_labels(runner_labels)
            if hardware_hint is None:
                hardware_hint = classify_hardware_from_job_name(job_name)

            test_patterns, test_dirs = _extract_test_patterns_from_steps(job_data)

            workflow_mapping[job_name] = {
                "runner_labels": runner_labels,
                "test_patterns": test_patterns,
                "test_dirs": test_dirs,
                "hardware_hint": hardware_hint,
                "steps": job_data.get("steps", []),
            }

        mapping[workflow_name] = workflow_mapping

    return mapping


def _extract_runner_labels(job_data: dict) -> list[str]:
    """Extract runner labels from job data."""
    runs_on = job_data.get("runs-on", "")
    if isinstance(runs_on, str):
        return [runs_on]
    if isinstance(runs_on, list):
        return [str(label) for label in runs_on]
    return []


def _extract_test_patterns_from_steps(job_data: dict) -> tuple[list[str], list[str]]:
    """Extract test file patterns and directories from job steps."""
    steps = job_data.get("steps", [])
    if not isinstance(steps, list):
        return [], []

    test_patterns: list[str] = []
    test_dirs: list[str] = []

    for step in steps:
        if not isinstance(step, dict):
            continue
        run_cmd = step.get("run", "")
        if not isinstance(run_cmd, str):
            continue

        for pattern in TEST_COMMAND_PATTERNS:
            for match in pattern.finditer(run_cmd):
                arg_str = match.group(1).strip()
                parts = arg_str.split()
                for part in parts:
                    if part.startswith("-"):
                        continue
                    part = part.strip("'\"")
                    if not part:
                        continue
                    if part.endswith(".py") or "*" in part:
                        test_patterns.append(part)
                    elif "/" in part or "\\" in part:
                        test_dirs.append(part)
                    else:
                        test_dirs.append(part)

    return test_patterns, test_dirs


def _count_files_in_path(repo_path: str, path_str: str, hardware: str | None) -> tuple[int, int]:
    """Count test files matching a path string, return (ascend_count, nvidia_count)."""
    ascend_count = 0
    nvidia_count = 0

    if "*" in path_str:
        full_pattern = os.path.join(repo_path, path_str)
        matched = glob.glob(full_pattern, recursive=True)
        for f in matched:
            if not _is_test_file(f):
                continue
            hw = classify_hardware_from_directory(os.path.relpath(f, repo_path))
            if hw == "ascend" or (hw is None and hardware == "ascend"):
                ascend_count += 1
            elif hw == "nvidia" or (hw is None and hardware == "nvidia"):
                nvidia_count += 1
            elif hw is None and hardware is None:
                ascend_count += 1
                nvidia_count += 1
    else:
        full_path = os.path.join(repo_path, path_str)
        if os.path.isdir(full_path):
            for test_pattern in TEST_FILE_PATTERNS:
                full_pattern = os.path.join(full_path, "**", test_pattern)
                matched = glob.glob(full_pattern, recursive=True)
                for f in matched:
                    hw = classify_hardware_from_directory(os.path.relpath(f, repo_path))
                    if hw == "ascend" or (hw is None and hardware == "ascend"):
                        ascend_count += 1
                    elif hw == "nvidia" or (hw is None and hardware == "nvidia"):
                        nvidia_count += 1
                    elif hw is None and hardware is None:
                        ascend_count += 1
                        nvidia_count += 1
        elif os.path.isfile(full_path):
            hw = classify_hardware_from_directory(os.path.relpath(full_path, repo_path))
            if hw == "ascend" or (hw is None and hardware == "ascend"):
                ascend_count += 1
            elif hw == "nvidia" or (hw is None and hardware == "nvidia"):
                nvidia_count += 1
            elif hw is None and hardware is None:
                ascend_count += 1
                nvidia_count += 1

    return ascend_count, nvidia_count


def count_test_files_for_job(
    repo_path: str,
    workflow_name: str,
    job_name: str,
    runner_labels: list[str],
    job_steps: list,
) -> dict:
    """Count test files for a specific job.

    Returns dict with keys: ascend_count, nvidia_count.
    """
    hardware = classify_hardware_from_runner_labels(runner_labels)
    if hardware is None:
        hardware = classify_hardware_from_job_name(job_name)

    test_patterns: list[str] = []
    test_dirs: list[str] = []

    for step in job_steps:
        if not isinstance(step, dict):
            continue
        run_cmd = step.get("run", "")
        if not isinstance(run_cmd, str):
            continue

        for pattern in TEST_COMMAND_PATTERNS:
            for match in pattern.finditer(run_cmd):
                arg_str = match.group(1).strip()
                parts = arg_str.split()
                for part in parts:
                    if part.startswith("-"):
                        continue
                    part = part.strip("'\"")
                    if not part:
                        continue
                    if part.endswith(".py") or "*" in part:
                        test_patterns.append(part)
                    elif "/" in part or "\\" in part:
                        test_dirs.append(part)
                    else:
                        test_dirs.append(part)

    ascend_count = 0
    nvidia_count = 0

    for pattern in test_patterns:
        a, n = _count_files_in_path(repo_path, pattern, hardware)
        ascend_count += a
        nvidia_count += n

    for dir_path in test_dirs:
        a, n = _count_files_in_path(repo_path, dir_path, hardware)
        ascend_count += a
        nvidia_count += n

    if not test_patterns and not test_dirs:
        for test_dir in TEST_DIR_NAMES:
            full_dir = os.path.join(repo_path, test_dir)
            if os.path.isdir(full_dir):
                for test_pattern in TEST_FILE_PATTERNS:
                    full_pattern = os.path.join(full_dir, "**", test_pattern)
                    matched = glob.glob(full_pattern, recursive=True)
                    for f in matched:
                        hw = classify_hardware_from_directory(os.path.relpath(f, repo_path))
                        if hw == "ascend" or (hw is None and hardware == "ascend"):
                            ascend_count += 1
                        elif hw == "nvidia" or (hw is None and hardware == "nvidia"):
                            nvidia_count += 1
                        elif hw is None and hardware is None:
                            ascend_count += 1
                            nvidia_count += 1

    return {
        "ascend_count": ascend_count,
        "nvidia_count": nvidia_count,
    }


def _is_test_file(filepath: str) -> bool:
    """Check if a file matches test file patterns."""
    basename = os.path.basename(filepath)
    return basename.startswith("test_") or basename.endswith("_test.py")


def compute_test_case_stats(repo_path: str, job_raw_rows: list[dict]) -> dict:
    """Compute test case statistics for a repo.

    Returns dict with keys: total, ascend, nvidia.
    """
    wf_mapping = parse_workflow_to_test_mapping(repo_path)

    total_ascend = 0
    total_nvidia = 0

    for row in job_raw_rows:
        workflow_name = row.get("workflow_name", "")
        job_name = row.get("job_name", "")
        runner_labels_str = row.get("runner_labels", "")

        if isinstance(runner_labels_str, str):
            runner_labels = [l.strip() for l in runner_labels_str.split(",") if l.strip()]
        elif isinstance(runner_labels_str, list):
            runner_labels = runner_labels_str
        else:
            runner_labels = []

        job_steps = []
        if workflow_name in wf_mapping and job_name in wf_mapping[workflow_name]:
            job_steps = wf_mapping[workflow_name][job_name].get("steps", [])

        result = count_test_files_for_job(
            repo_path=repo_path,
            workflow_name=workflow_name,
            job_name=job_name,
            runner_labels=runner_labels,
            job_steps=job_steps,
        )

        total_ascend += result["ascend_count"]
        total_nvidia += result["nvidia_count"]

    return {
        "total": total_ascend + total_nvidia,
        "ascend": total_ascend,
        "nvidia": total_nvidia,
    }


def write_test_case_stats_to_supabase(
    repo: str,
    window_start: str,
    window_end: str,
    stats: dict,
    supabase_url: str | None = None,
    supabase_key: str | None = None,
) -> None:
    """Upsert test case statistics into Supabase test_case_stats table.

    Uses INSERT ... ON CONFLICT DO UPDATE (via Prefer: resolution=merge-duplicates)
    so running the report multiple times for the same window doesn't create duplicates.

    The conflict key is (repo_id, window_start, window_end). repo_id is looked up
    from the repos table by owner/repo.

    Args:
        repo: Repository in "owner/repo" format (e.g., "vllm-project/vllm-ascend").
        window_start: Start date in YYYY-MM-DD format.
        window_end: End date in YYYY-MM-DD format.
        stats: Dict with keys "total", "ascend", "nvidia".
        supabase_url: Supabase URL (falls back to SUPABASE_URL env var).
        supabase_key: Supabase service role key (falls back to SUPABASE_SERVICE_ROLE_KEY env var).
    """
    if requests is None:
        print("  Warning: requests not available, skipping Supabase write for test case stats")
        return

    url = supabase_url or os.environ.get("SUPABASE_URL")
    key = supabase_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        print("  Warning: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY not set, skipping Supabase write for test case stats")
        return

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    try:
        # Step 1: Look up repo_id from repos table by owner/repo
        owner, repo_name = repo.split("/", 1)
        resp = requests.get(
            f"{url}/rest/v1/repos",
            headers={**headers, "Prefer": "return=representation"},
            params={"owner": f"eq.{owner}", "repo": f"eq.{repo_name}"},
            timeout=15,
        )
        resp.raise_for_status()
        repos = resp.json()

        if not repos:
            print(f"  Warning: repo '{repo}' not found in repos table, skipping Supabase write for test case stats")
            return

        repo_id = repos[0]["id"]

        # Step 2: Upsert into test_case_stats table
        payload = {
            "repo_id": repo_id,
            "window_start": window_start,
            "window_end": window_end,
            "total_test_cases": stats.get("total", 0),
            "ascend_test_cases": stats.get("ascend", 0),
            "nvidia_test_cases": stats.get("nvidia", 0),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

        resp = requests.post(
            f"{url}/rest/v1/test_case_stats",
            headers=headers,
            json=payload,
            timeout=15,
        )
        # Supabase returns 200/201 on success, 409 on conflict without merge-duplicates
        if resp.status_code not in (200, 201, 204):
            print(f"  Warning: Supabase upsert failed with status {resp.status_code}: {resp.text[:200]}")
        else:
            print(f"  Test case stats written to Supabase for repo={repo}, window={window_start}..{window_end}")

    except requests.exceptions.RequestException as e:
        print(f"  Warning: Failed to write test case stats to Supabase: {e}")
    except Exception as e:
        print(f"  Warning: Unexpected error writing test case stats to Supabase: {e}")
