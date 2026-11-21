#!/usr/bin/env python3
"""Generate a read-only native PR/NPU efficiency snapshot (August–October 2026)."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
import yaml
from scripts.card_quantity import RULE_SOURCE, RULE_VERSION
from scripts.runner_resource_evidence import resource_evidence
from scripts.ci_analyze import DEFAULT_PG_URL, PostgresClient, load_env

START = '2026-08-01T00:00:00+00:00'
END = '2026-11-01T00:00:00+00:00'
MONTHS = ('2026-08', '2026-09', '2026-10')


def dt(value):
    try:
        value = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
        return value.astimezone(timezone.utc) if value and value.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def duration(a, b):
    a, b = dt(a), dt(b)
    if a is None or b is None:
        return None
    seconds = (b - a).total_seconds()
    return seconds if seconds >= 0 else None


def percentile(values, p):
    if not values:
        return None
    v = sorted(values)
    pos = (len(v) - 1) * p
    lo = int(pos)
    return round(v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (pos - lo), 2)


def aggregate(rows, allow, cutoff):
    """Aggregate native LEFT JOIN rows; never invent attempt 1 or consult links."""
    data = {(repo, month): {'counts': Counter(), 'runs': set(), 'attempts': set(),
                            'npu_attempts': set(), 'jobs': set(), 'queues': [],
                            'models': defaultdict(lambda: {'jobs': 0, 'card_hours': 0.0})}
            for repo in allow for month in MONTHS}
    for row in rows:
        created = dt(row.get('created_at'))
        if not created or not (dt(START) <= created < dt(cutoff)):
            continue
        repo, workflow = row['repo'], row['workflow']
        if repo not in allow or workflow not in allow[repo]:
            continue
        month = created.strftime('%Y-%m')
        if (repo, month) not in data:
            continue
        d = data[repo, month]
        c = d['counts']
        run = row['run_id']
        d['runs'].add(run)
        attempt = row.get('run_attempt')
        if attempt is None:
            c['missing_attempt_runs'] += 1
            continue
        aid = (run, attempt)
        d['attempts'].add(aid)
        jid = row.get('job_id')
        if jid is None:
            c['zero_job_attempts'] += 1
            continue
        key = (*aid, jid)
        if key in d['jobs']:
            continue
        d['jobs'].add(key)
        kind, model, cards, reason = resource_evidence(row)
        c['hardware_' + kind + '_jobs'] += 1
        if kind == 'conflict' or 'conflict' in reason:
            c['conflict_jobs'] += 1
        if kind != 'npu':
            continue
        d['npu_attempts'].add(aid)
        c['npu_jobs'] += 1
        if cards is None:
            c['npu_missing_quantity_jobs'] += 1
        queue = duration(row.get('job_created_at'), row.get('started_at'))
        if queue is None:
            c['npu_bad_queue_time_jobs'] += 1
        else:
            d['queues'].append(queue / 60)
        seconds = duration(row.get('started_at'), row.get('completed_at'))
        if seconds is None:
            c['npu_bad_execution_time_jobs'] += 1
        if row.get('job_status') != 'completed':
            c['npu_nonterminal_jobs'] += 1
        elif row.get('job_conclusion') == 'skipped':
            c['npu_skipped_jobs'] += 1
        elif cards is not None and seconds is not None:
            m = d['models'][model]
            m['jobs'] += 1
            m['card_hours'] += cards * seconds / 3600
            c['npu_card_hour_samples'] += 1
    result = []
    fields = ('missing_attempt_runs', 'zero_job_attempts', 'npu_jobs', 'hardware_unknown_jobs',
              'conflict_jobs', 'npu_missing_quantity_jobs', 'npu_bad_queue_time_jobs',
              'npu_bad_execution_time_jobs', 'npu_skipped_jobs', 'npu_nonterminal_jobs', 'npu_card_hour_samples')
    for (repo, month), d in sorted(data.items()):
        present = bool(d['runs'])
        c = d['counts']
        item = {'repo': repo, 'month': month, 'sample_note': None if present else '无匹配 run；非零的证据缺失，不代表没有工作',
                'runs': len(d['runs']) if present else None,
                'native_attempts': len(d['attempts']) if present else None,
                'npu_evidence_attempts': len(d['npu_attempts']) if present else None,
                **{f: c[f] if present else None for f in fields},
                'queue_samples': len(d['queues']) if present else None,
                'queue_p50_minutes': percentile(d['queues'], .5), 'queue_p90_minutes': percentile(d['queues'], .9),
                'card_hours_by_model': {k: {'jobs': v['jobs'], 'card_hours': round(v['card_hours'], 3)}
                                        for k, v in sorted(d['models'].items())} or None}
        result.append(item)
    return result


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(report):
    esc = lambda x: html.escape(str(x))
    columns = ['repo', 'month', 'runs', 'native_attempts', 'npu_evidence_attempts', 'npu_jobs',
               'queue_samples', 'queue_p50_minutes', 'queue_p90_minutes', 'card_hours_by_model',
               'missing_attempt_runs', 'zero_job_attempts', 'hardware_unknown_jobs', 'conflict_jobs',
               'npu_missing_quantity_jobs', 'npu_bad_queue_time_jobs', 'npu_bad_execution_time_jobs',
               'npu_skipped_jobs', 'npu_nonterminal_jobs', 'sample_note']
    table = '<table><thead><tr>' + ''.join('<th>' + esc(k) + '</th>' for k in columns) + '</tr></thead><tbody>'
    for row in report['rows']:
        table += '<tr>' + ''.join('<td>' + esc(json.dumps(row[k], ensure_ascii=False) if isinstance(row[k], dict) else ('—' if row[k] is None else row[k])) + '</td>' for k in columns) + '</tr>'
    table += '</tbody></table>'
    meta = esc(json.dumps(report['provenance'], ensure_ascii=False, indent=2))
    return '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NPU PR 效率快照</title><style>:root{color-scheme:light dark}body{font:14px system-ui;max-width:1600px;margin:auto;padding:24px;background:#f6f8fc;color:#172337}h1{font-size:28px}section{overflow:auto}table{border-collapse:collapse;background:white}th,td{border:1px solid #ccd5e1;padding:8px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#e8eef7}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#101722;color:#e1e9f5}table{background:#192536}th{background:#26364a}td,th{border-color:#40516a}}</style><h1>NPU PR 效率快照</h1><p>UTC run 创建时间归月；原生 attempts/jobs，PR 事件及 workflow 白名单，不依赖 PR 链接或旧表，不补 attempt 1。10 月截至快照为部分月，不作因果提升结论。无样本为 —，不是零。</p><p>排队为 NPU job created → started 的非负分钟，P50/P90 线性插值；卡时仅 completed、非 skipped、有数量和非负执行时间的 job，按型号独立列示（失败或取消的 completed job 仍计入）。静态配置不分摊 job；未知、冲突与时间缺口可能重叠。零 job 不证明漏采。规则为用户确认的 A3 N/2、HK 等；历史硬件未独立验证。</p><section>''' + table + '</section><h2>快照、规则与配置</h2><pre>' + meta + '</pre></html>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, help='new HTML path; same-stem JSON is also created (no overwrite)')
    args = parser.parse_args()
    # ADR-042: drilldown scope comes from npu_drilldown flags in the unified inventory.
    inventory = ROOT / 'etl/repos.yaml'
    inv_data = yaml.safe_load(inventory.read_text())['repos']
    allow = {r['repo']: sorted({w['file'] for w in r['workflows'] if w.get('npu_drilldown')}) for r in inv_data}
    allow = {repo: files for repo, files in allow.items() if files}
    inv = {r['repo']: {w['file'] for w in r.get('workflows', []) if w.get('file')} for r in inv_data}
    db_url = os.getenv('PG_DATABASE_URL') or load_env(ROOT / '.env').get('PG_DATABASE_URL') or DEFAULT_PG_URL
    db = PostgresClient(db_url)
    try:
        db._conn = db._pg8000.connect(**db._parse_dsn(db_url))
        cur = db._conn.cursor()
        cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cur.execute("SELECT transaction_timestamp(), current_setting('transaction_read_only'), current_setting('transaction_isolation')")
        snapshot, ro, isolation = cur.fetchone()
        if (ro, isolation) != ('on', 'repeatable read'):
            raise RuntimeError('Unsafe transaction')
        cutoff = min(dt(END), dt(snapshot)).isoformat()
        ids = {r['repo']: r['id'] for r in db.query("SELECT id, owner || '/' || repo AS repo FROM repos")}
        rows = []
        for repo, files in allow.items():
            if repo not in ids or not files:
                continue
            placeholders = ','.join(['%s'] * len(files))
            rows.extend(db.query(f'''SELECT %s AS repo, COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow,
                r.id AS run_id, r.created_at, a.run_attempt, a.status AS attempt_status, a.jobs_fetched_at,
                j.job_id, j.status AS job_status, j.conclusion AS job_conclusion, j.created_at AS job_created_at,
                j.started_at, j.completed_at, j.labels_json, j.resource_model, j.resource_count
                FROM runs r LEFT JOIN workflow_attempts a ON a.run_id=r.id
                LEFT JOIN workflow_jobs j ON j.run_id=a.run_id AND j.run_attempt=a.run_attempt
                WHERE r.repo_id=%s AND r.event='pull_request' AND r.created_at::timestamptz >= %s::timestamptz
                AND r.created_at::timestamptz < %s::timestamptz
                AND COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) IN ({placeholders})''',
                (repo, ids[repo], START, cutoff, *files)))
        provenance = {'snapshot_utc': dt(snapshot).isoformat(), 'start_inclusive_utc': START, 'end_exclusive_utc': cutoff,
                      'requested_end_exclusive_utc': END, 'read_only': ro, 'isolation': isolation,
                      'allowlist_sha256': sha(config), 'inventory_sha256': sha(inventory),
                      'script_sha256': sha(Path(__file__)), 'rule_version': RULE_VERSION, 'rule_source': RULE_SOURCE,
                      'rule_sha256': {name: sha(SKILL / 'scripts' / name) for name in ('card_quantity.py', 'runner_resource_evidence.py')},
                      'allowlist_not_in_inventory': sorted(set(allow) - set(inv)),
                      'inventory_not_in_allowlist': sorted(set(inv) - set(allow)),
                      'allowlist_workflows_not_in_inventory': {r: sorted(set(fs) - inv.get(r, set())) for r, fs in allow.items() if set(fs) - inv.get(r, set())},
                      'allowlist_repos_missing_from_db': sorted(set(allow) - set(ids)),
                      'historical_hardware_verified': False}
        report = {'provenance': provenance, 'rows': aggregate(rows, allow, cutoff)}
    finally:
        db.close()
    out = args.out or ROOT / 'reports' / f'npu-efficiency-native-{snapshot:%Y%m%dT%H%M%SZ}.html'
    json_path = out.with_suffix('.json')
    if out == json_path or out.exists() or json_path.exists():
        raise FileExistsError('Refusing to overwrite output')
    out.parent.mkdir(parents=True, exist_ok=True)
    with json_path.open('x', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with out.open('x', encoding='utf-8') as f:
        f.write(render(report))
    print(json.dumps({'html': str(out), 'json': str(json_path), 'snapshot': provenance['snapshot_utc'], 'rows': len(rows)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
