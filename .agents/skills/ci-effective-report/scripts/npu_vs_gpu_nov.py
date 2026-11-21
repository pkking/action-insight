#!/usr/bin/env python3
"""Read-only Nov-2026 NPU vs GPU per-repo compute comparison (PR-event jobs).

NPU: card-hours via the governed evidence rules (runner_resource_evidence),
identical to the daily-trend report.
GPU: label-derived card counts (N-gpu-<model> labels); 'nvidia' labels
without a count are counted as jobs only and never converted.
Both sides use completed non-skipped jobs with valid [started, completed]
intervals, clamped to the Nov window; missing data stays unknown, not zero.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sys
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import yaml
from scripts.ci_analyze import DEFAULT_PG_URL, PostgresClient, load_env
from scripts.runner_resource_evidence import resource_evidence

UTC = timezone.utc
NOV_START = datetime(2026, 11, 1, tzinfo=UTC)
NOV_END = datetime(2026, 12, 1, tzinfo=UTC)  # clamped by snapshot
GPU_QTY = re.compile(r'"(\d+)-gpu')
NVIDIA_HINT = re.compile(r'nvidia', re.I)
# verl dynamic GPU runners: uv_cu130* = CUDA 13.0 image on 8x NVIDIA L20 (verified
# via job logs: CUDA_VISIBLE_DEVICES ranges over 0-7, pip list shows nvidia-* wheels,
# workflow fallback label is L20x8). Label itself carries no card count.
VERL_GPU_LABELS = re.compile(r'uv_cu\d+(?:_dev\d+)?', re.I)
VERL_GPU_CARDS = 8
# ADR-041 families 6/7 (report side): GPU labels that carry their own card counts.
# nvidia-h100-1 -> 1 card (fla-org); gcp-a2-highgpu-2g -> 2 x A100 (GCP machine-type
# naming encodes the GPU count; AReaL runner labels embed the run id after it).
GPU_MODEL_COUNT_RE = re.compile(r'"nvidia-[a-z0-9]+-([1-9]\d*)"', re.I)
GCP_GPU_COUNT_RE = re.compile(r'"gcp-a2-highgpu-([1-9][0-9]*)g', re.I)

# Ascend GHA runners platform integration list, checked 2026-11-20.
# Source: https://ascend-gha-runners.github.io/docs/Repo/
# runs_on: whether the repo's runs-on integration is confirmed (✅) on that page.
INTEGRATED_REPOS = {
    'vllm-project/vllm-ascend': {'runs_on': True},
    'vllm-project/vllm-omni': {'runs_on': None},
    'sgl-project/sgl-kernel-npu': {'runs_on': True},
    'sgl-project/sglang': {'runs_on': None},
    'verl-project/verl': {'runs_on': None},
    'hiyouga/LlamaFactory': {'runs_on': None},
    'modelscope/ms-swift': {'runs_on': None},
    'triton-lang/triton-ascend': {'runs_on': True},
    'vllm-ascend/vllm-ascend-recipes': {'runs_on': None},
    'verl-project/verl-omni': {'runs_on': None},
    'Ascend/pytorch': {'runs_on': None},
    'Ascend/sglang': {'runs_on': None},
    'alibaba/ROLL': {'runs_on': True},
    'areal-project/AReaL': {'runs_on': True},
    'fla-org/flash-linear-attention': {'runs_on': True},
    'tile-ai/tilelang-mlir-ascend': {'runs_on': None},
    'verl-project/verl-SpeCo': {'runs_on': None},
    'Ascend/cann-container-image': {'runs_on': None},
    'XPU-Forces/mojo_opset': {'runs_on': True},
    'sgl-project/sglang-omni': {'runs_on': None},
    'tile-ai/tilelang': {'runs_on': None},
    'verl-project/uni-agent': {'runs_on': True},
}
# Manual GitHub probe of repos missing from the local DB (lead-agent sampling,
# 2026-11-20): November run counts (API caps display at 2500) and accelerator
# labels observed in recent job samples. Evidence only — never card-hour estimates.
INTEGRATED_PROBE_20261120 = {
    'vllm-project/vllm-omni': {'nov_runs': 2500, 'runs_cap': True, 'accel_labels': []},
    'sgl-project/sgl-kernel-npu': {'nov_runs': 2500, 'runs_cap': True,
        'accel_labels': ['linux-aarch64-a2-8', 'linux-aarch64-a3-800t-16', 'linux-amd64-a5-4', 'linux-aarch64-a3-800t-2', 'linux-amd64-a5-1']},
    'vllm-ascend/vllm-ascend-recipes': {'nov_runs': 1406, 'runs_cap': False,
        'accel_labels': ['linux-aarch64-a2b4-8', 'linux-aarch64-a3-800i-recipes-fed-16', 'linux-aarch64-a5-8']},
    'verl-project/verl-omni': {'nov_runs': 2458, 'runs_cap': False, 'accel_labels': ['uv_cu130']},
    'Ascend/sglang': {'nov_runs': 2500, 'runs_cap': True, 'accel_labels': []},
    'fla-org/flash-linear-attention': {'nov_runs': 2500, 'runs_cap': True, 'accel_labels': ['nvidia-h100-1']},
    'Ascend/cann-container-image': {'nov_runs': 18, 'runs_cap': False, 'accel_labels': []},
    'XPU-Forces/mojo_opset': {'nov_runs': 95, 'runs_cap': False,
        'accel_labels': ['linux-aarch64-a2-mojo-fed-1', 'linux-aarch64-a2-mojo-fed-2', 'linux-aarch64-a2-mojo-fed-4', 'linux-aarch64-a2-mojo-fed-8']},
    'verl-project/uni-agent': {'nov_runs': 1599, 'runs_cap': False,
        'accel_labels': ['linux-aarch64-a2-8', 'uv_cu130_dev5']},
}


def dt(value):
    try:
        value = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
        return value.astimezone(UTC) if value and value.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def clamp_hours(start, end, lo, hi):
    start, end = max(start, lo), min(end, hi)
    return max((end - start).total_seconds(), 0) / 3600


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--scope', choices=('integrated', 'allowlist'), default='integrated',
                        help='integrated: all repos on the ascend-gha-runners platform list; allowlist: drilldown-workflows.yaml repos')
    args = parser.parse_args()
    # ADR-042: drilldown scope comes from npu_drilldown flags in the unified inventory.
    inventory = ROOT / 'etl' / 'repos.yaml'
    allow = {r['repo']: sorted({w['file'] for w in r['workflows'] if w.get('npu_drilldown')})
             for r in yaml.safe_load(inventory.read_text())['repos']}
    allow = {repo: files for repo, files in allow.items() if files}
    scope = INTEGRATED_REPOS if args.scope == 'integrated' else {r: None for r in allow}
    url = os.getenv('PG_DATABASE_URL') or load_env(ROOT / '.env').get('PG_DATABASE_URL') or DEFAULT_PG_URL

    db = PostgresClient(url)
    try:
        db._conn = db._pg8000.connect(**db._parse_dsn(url))
        cur = db._conn.cursor()
        cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cur.execute("SET LOCAL statement_timeout='120s'")
        cur.execute('SELECT transaction_timestamp()')
        snapshot, = cur.fetchone()
        cutoff = min(NOV_END, dt(snapshot))
        ids_ci = {r['repo'].lower(): (r['repo'], r['id']) for r in db.query("SELECT id, owner || '/' || repo AS repo FROM repos")}
        db_names = {v[0] for v in ids_ci.values()}
        rows = []
        # All workflows (GPU compute lives mostly outside the NPU allowlist) and all
        # events (nightly/schedule jobs consume the pool too); PR-event rows are
        # separated later from r.event for comparability with trend reports.
        for repo in scope:
            match = ids_ci.get(repo.lower())
            if not match:
                continue
            db_name, repo_id = match
            rows.extend(db.query('''SELECT %s AS repo, r.event,
              COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow,
              j.job_id, j.run_attempt, j.status, j.conclusion,
              j.started_at, j.completed_at, j.labels_json, j.resource_model, j.resource_count
              FROM workflow_jobs j JOIN runs r ON r.id=j.run_id
              WHERE r.repo_id=%s
              AND j.created_at >= %s AND j.created_at < %s''',
              (db_name, repo_id, NOV_START.isoformat(), cutoff.isoformat())))
    finally:
        db.close()

    def bucket(ev):
        return 'pr' if ev == 'pull_request' else 'other'

    npu_h = defaultdict(lambda: defaultdict(float)); gpu_h = defaultdict(lambda: defaultdict(float))
    npu_jobs = defaultdict(lambda: defaultdict(int)); gpu_jobs = defaultdict(lambda: defaultdict(int))
    npu_unknown_qty = defaultdict(int); unknown_qty = defaultdict(int)
    wall = defaultdict(float)
    for r in rows:
        if r['status'] != 'completed' or r['conclusion'] == 'skipped':
            continue
        start, end = dt(r['started_at']), dt(r['completed_at'])
        if not start or not end or end <= start or end <= NOV_START or start >= cutoff:
            continue
        hours = clamp_hours(start, end, NOV_START, cutoff)
        cls = bucket(r['event'])
        kind, model, cards, _reason = resource_evidence(r)
        if kind == 'npu':
            if cards is not None:
                npu_h[r['repo']][cls] += hours * cards
                npu_h[r['repo']]['all'] += hours * cards
                npu_jobs[r['repo']][cls] += 1
                npu_jobs[r['repo']]['all'] += 1
            else:
                npu_unknown_qty[r['repo']] += 1
            continue
        m = GPU_QTY.search(r['labels_json'] or '') or GPU_MODEL_COUNT_RE.search(r['labels_json'] or '') or GCP_GPU_COUNT_RE.search(r['labels_json'] or '')
        if m:
            gpu_h[r['repo']][cls] += hours * int(m[1]); gpu_h[r['repo']]['all'] += hours * int(m[1])
            gpu_jobs[r['repo']][cls] += 1; gpu_jobs[r['repo']]['all'] += 1
            wall[r['repo']] += hours
        elif (r['labels_json'] or '').strip('[]"') and VERL_GPU_LABELS.fullmatch((r['labels_json'] or '').strip('[]"')):
            gpu_h[r['repo']][cls] += hours * VERL_GPU_CARDS; gpu_h[r['repo']]['all'] += hours * VERL_GPU_CARDS
            gpu_jobs[r['repo']][cls] += 1; gpu_jobs[r['repo']]['all'] += 1
            wall[r['repo']] += hours
        elif kind == 'gpu':
            # GPU confirmed by evidence rules but label carries no card count
            # (e.g. bare nvidia labels, gcp-a2-highgpu-*): jobs visible, hours unknown.
            unknown_qty[r['repo']] += 1
            wall[r['repo']] += hours

    local_repos = sorted(set(npu_h) | set(gpu_h) | set(unknown_qty) | set(npu_unknown_qty))

    repo_rows = []
    ordered = list(INTEGRATED_REPOS) if args.scope == 'integrated' else local_repos
    db_repos_ci = {n.lower() for n in db_names}
    for repo in ordered:
        if repo.lower() not in db_repos_ci and args.scope == 'integrated':
            probe = INTEGRATED_PROBE_20261120.get(repo)
            repo_rows.append({'repo': repo, 'local_data': False,
                              'runs_on_confirmed': INTEGRATED_REPOS[repo]['runs_on'],
                              'npu_card_hours_pr': None, 'npu_card_hours_all': None,
                              'gpu_card_hours_pr': None, 'gpu_card_hours_all': None,
                              'npu_jobs_all': 0, 'gpu_jobs_all': 0, 'gpu_unknown_qty_jobs': 0,
                              'gpu_job_wall_hours': 0.0,
                              'probe': probe})
            continue
        db_key = ids_ci[repo.lower()][0]  # aggregate under the DB's own name casing
        h_n, h_g = npu_h[db_key], gpu_h[db_key]
        repo_rows.append({'repo': repo, 'local_data': True,
                          'runs_on_confirmed': (INTEGRATED_REPOS.get(repo) or {}).get('runs_on'),
                          'npu_card_hours_pr': round(h_n['pr'], 1), 'npu_card_hours_all': round(h_n['all'], 1),
                          'gpu_card_hours_pr': round(h_g['pr'], 1), 'gpu_card_hours_all': round(h_g['all'], 1),
                          'npu_jobs_pr': npu_jobs[db_key]['pr'], 'npu_jobs_all': npu_jobs[db_key]['all'],
                          'npu_unknown_qty_jobs': npu_unknown_qty[db_key],
                          'gpu_jobs_all': gpu_jobs[db_key]['all'], 'gpu_unknown_qty_jobs': unknown_qty[db_key],
                          'gpu_job_wall_hours': round(wall[db_key], 1), 'probe': INTEGRATED_PROBE_20261120.get(repo)})
    report = {'provenance': {'snapshot_utc': dt(snapshot).isoformat(), 'window': ['2026-11-01', cutoff.date().isoformat()],
                             'scope': args.scope,
                             'integrated_source': 'https://ascend-gha-runners.github.io/docs/Repo/ (checked 2026-11-20)',
                             'definitions': {'npu_card_hours': 'governed evidence rules (resource_evidence) × hours; scoped conventions now applied (same as trend report, workflow passed into evidence; ADR-041 §3.0)',
                                             'gpu_card_hours': 'label N-gpu-<model> count × hours; verl uv_cu130* = 8 L20; nvidia labels without count excluded from hours',
                                             'job_wall_hours': 'completed non-skipped job wall-clock hours regardless of card count',
                                             'pr_vs_all': 'pr = pull_request event only (trend-report comparable); all = every event (nightly/schedule/push included)'}},
              'repos': repo_rows}
    out = args.out or ROOT / 'reports' / f'npu-vs-gpu-nov-2026-{args.scope}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"{'repo':38}{'NPU(PR)':>10}{'NPU(全部)':>11}{'GPU(全部)':>10}{'NPU jobs':>9}{'GPU jobs':>9}{'本地':>4}")
    for row in report['repos']:
        npr = f"{row['npu_card_hours_pr']:,.0f}" if row['npu_card_hours_pr'] is not None else '—'
        nal = f"{row['npu_card_hours_all']:,.0f}" if row['npu_card_hours_all'] is not None else '—'
        gal = f"{row['gpu_card_hours_all']:,.0f}" if row['gpu_card_hours_all'] is not None else '—'
        print(f"{row['repo']:38}{npr:>10}{nal:>11}{gal:>10}{row['npu_jobs_all']:>9}{row['gpu_jobs_all']:>9}{('有' if row['local_data'] else '无'):>4}")
    print('out:', out)


if __name__ == '__main__':
    main()
