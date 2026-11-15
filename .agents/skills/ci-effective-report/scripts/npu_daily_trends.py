#!/usr/bin/env python3
"""Read-only native PR-event NPU daily trend report (UTC Aug–Nov 2026)."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
import yaml
from scripts.card_quantity import RULE_SOURCE, RULE_VERSION
from scripts.ci_analyze import DEFAULT_PG_URL, PostgresClient, load_env
from scripts.runner_resource_evidence import resource_evidence

UTC = timezone.utc
START = datetime(2026, 8, 1, tzinfo=UTC)
END = datetime(2026, 11, 9, tzinfo=UTC)
DAYS = [(START + timedelta(days=i)).date().isoformat() for i in range((END - START).days)]

# Select whole runs so sibling jobs remain available as attempt-level NPU evidence.
CANDIDATE_SQL = '''(r.created_at >= %s AND r.created_at < %s OR EXISTS (
    SELECT 1 FROM workflow_attempts ca LEFT JOIN workflow_jobs cj
      ON cj.run_id=ca.run_id AND cj.run_attempt=ca.run_attempt
    WHERE ca.run_id=r.id AND (
      ca.run_started_at >= %s AND ca.run_started_at < %s OR
      cj.created_at >= %s AND cj.created_at < %s OR
      cj.started_at < %s AND (cj.completed_at IS NULL OR cj.completed_at >= %s)
    )))'''


def dt(value):
    try:
        value = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
        return value.astimezone(UTC) if value and value.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def percentile(values, p):
    if not values:
        return None
    v = sorted(values)
    pos = (len(v) - 1) * p
    lo = int(pos)
    return v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (pos - lo)


def rolling(values, dates, cutoff):
    out = []
    for i, day in enumerate(dates):
        window = values[i-6:i+1] if i >= 6 else []
        complete = datetime.fromisoformat(day).replace(tzinfo=UTC) + timedelta(days=1) <= cutoff
        out.append(sum(window) / 7 if complete and len(window) == 7 and all(v is not None for v in window) else None)
    return out


def split_hours(start, end, cards, cutoff):
    """Yield positive intersections and preserve a valid zero-duration observation."""
    start, end = dt(start), dt(end)
    if start is None or end is None or end < start:
        return None
    if start == end:
        return [(start.date().isoformat(), 0.0)] if START <= start < cutoff else []
    start, end = max(start, START), min(end, cutoff)
    result = []
    while start < end:
        midnight = datetime.combine(start.date() + timedelta(days=1), datetime.min.time(), UTC)
        stop = min(end, midnight)
        result.append((start.date().isoformat(), (stop - start).total_seconds() * cards / 3600))
        start = stop
    return result


def aggregate(rows, allow, cutoff):
    """Rows are native joined records; all observations and coverage retain identity."""
    cutoff = dt(cutoff)
    audit = {(repo, wf, day): {'runs': set(), 'attempts': set(), 'jobs': set(), 'missing_attempt_runs': set(), 'zero_job_attempts': set(), 'missing_prior_attempts': 0} for repo, files in allow.items() for wf in files for day in DAYS}
    buckets = defaultdict(lambda: {'models': defaultdict(float), 'conclusions': defaultdict(float), 'card_jobs': set(), 'queues': [], 'attempts': Counter()})
    issues = defaultdict(Counter)
    jobs_seen, attempts, runs = set(), {}, {}
    for r in rows:
        repo, wf, rid = r['repo'], r['workflow'], r['run_id']
        if repo not in allow or wf not in allow[repo]:
            continue
        rk = (repo, wf, rid)
        created = dt(r.get('created_at'))
        runs[rk] = created
        run_day = created.date().isoformat() if created and START <= created < cutoff else None
        a = r.get('run_attempt')
        if run_day in DAYS:
            audit[repo, wf, run_day]['runs'].add(rid)
            if a is None:
                audit[repo, wf, run_day]['missing_attempt_runs'].add(rid)
        if a is None:
            continue
        ak = (*rk, a)
        if ak not in attempts:
            started = dt(r.get('attempt_started_at'))
            attempts[ak] = {'row': r, 'npu': False, 'jobs': set(),
                            'relevant': bool(run_day or (started and START <= started < cutoff))}
        if run_day in DAYS:
            audit[repo, wf, run_day]['attempts'].add(ak)
        jid = r.get('job_id')
        if jid is None:
            continue
        jk = (*ak, jid)
        attempts[ak]['jobs'].add(jk)
        if run_day in DAYS:
            audit[repo, wf, run_day]['jobs'].add(jk)
        if jk in jobs_seen:
            continue
        jobs_seen.add(jk)
        jc, js, je = dt(r.get('job_created_at')), dt(r.get('started_at')), dt(r.get('completed_at'))
        relevant = (jc is not None and START <= jc < cutoff) or (js is not None and js < cutoff and (je is None or je >= START))
        if relevant:
            attempts[ak]['relevant'] = True
        kind, model, cards, reason = resource_evidence(r)
        issues[repo]['candidate_jobs_' + kind] += 1
        if relevant:
            issues[repo]['window_jobs_' + kind] += 1
        elif not jc and not js:
            issues[repo]['candidate_jobs_undated'] += 1
        if kind != 'npu':
            continue
        attempts[ak]['npu'] = True
        if not relevant:
            continue
        issue = issues[repo]
        issue['npu_jobs'] += 1
        if cards is None:
            issue['quantity_unknown'] += 1
            issue['quantity_reason_' + reason] += 1
        if jc and START <= jc < cutoff:
            if js and js >= jc:
                buckets[repo, jc.date().isoformat()]['queues'].append((js - jc).total_seconds() / 60)
            else:
                issue['queue_missing_or_negative'] += 1
        if r.get('job_status') != 'completed':
            issue['job_nonterminal'] += 1
        elif r.get('job_conclusion') == 'skipped':
            issue['job_skipped'] += 1
        else:
            if not js or not je:
                issue['execution_missing'] += 1
            elif je < js:
                issue['execution_negative'] += 1
            else:
                issue['execution_valid'] += 1
            if js and je and je >= js and cards is not None and model:
                issue['card_eligible'] += 1
                conclusion = r.get('job_conclusion')
                share = conclusion if conclusion in ('success', 'failure', 'cancelled') else 'other'
                for day, hours in split_hours(js, je, cards, cutoff):
                    b = buckets[repo, day]
                    b['models'][model] += hours
                    b['conclusions'][share] += hours
                    b['card_jobs'].add(jk)
    per_run = defaultdict(set)
    for ak, info in attempts.items():
        repo, wf, rid, num = ak
        per_run[repo, wf, rid].add(num)
        created = runs[repo, wf, rid]
        day = created.date().isoformat() if created and START <= created < cutoff else None
        if day in DAYS and not info['jobs']:
            audit[repo, wf, day]['zero_job_attempts'].add(ak)
        if not info['npu']:
            continue
        row = info['row']
        started = dt(row.get('attempt_started_at'))
        if not started:
            if info['relevant']:
                issues[repo]['npu_attempts_undated'] += 1
            continue
        if not START <= started < cutoff:
            continue
        status, conclusion = row.get('attempt_status'), row.get('attempt_conclusion')
        category = 'nonterminal' if status != 'completed' else conclusion if conclusion in ('success', 'failure', 'cancelled') else 'other'
        buckets[repo, started.date().isoformat()]['attempts'][category] += 1
    for rk, nums in per_run.items():
        created = runs[rk]
        if created and START <= created < cutoff:
            audit[rk[0], rk[1], created.date().isoformat()]['missing_prior_attempts'] += max(nums) - len(nums)
    audit_rows = []
    for (repo, wf, day), item in sorted(audit.items()):
        audit_rows.append({'repo': repo, 'workflow': wf, 'date': day, **{k: len(v) if isinstance(v, set) else v for k, v in item.items()}, 'collection': 'observed_unknown_completeness' if item['runs'] else 'unknown'})
    keys = ('npu_jobs', 'quantity_unknown', 'queue_missing_or_negative', 'execution_missing',
            'execution_negative', 'execution_valid', 'card_eligible', 'job_nonterminal', 'job_skipped', 'npu_attempts_undated')
    keys = sorted(set(keys) | {key for counter in issues.values() for key in counter})
    by_repo = {repo: {key: issues[repo][key] for key in keys} for repo in allow}
    total = {key: sum(item[key] for item in by_repo.values()) for key in keys}
    return buckets, audit_rows, {'total': total, 'by_repo': by_repo}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_backfill_receipt(path):
    """Read a scoped verification claim, not proof of full-day or full-window coverage."""
    if path is None:
        return {'status': 'not_provided', 'scope': '未提供补采证明；覆盖情况仍以本地审计为准。'}
    raw = path.read_bytes()
    receipt = json.loads(raw)
    if not isinstance(receipt, dict):
        raise ValueError('invalid backfill receipt: expected object')
    expected = {'status': 'verified_complete_for_manifest_pr_scope',
                'window_start_utc': '2026-08-01T00:00:00Z',
                'window_end_exclusive_utc': '2026-08-02T00:00:00Z',
                'event': 'pull_request', 'pending_manifest_pr_runs': 0, 'pending_intent': False}
    if any(receipt.get(k) != v or type(receipt.get(k)) is not type(v) for k, v in expected.items()):
        raise ValueError('invalid backfill receipt: unsupported or incomplete verification scope')
    counts = ('restored_runs', 'restored_attempts', 'restored_jobs')
    if any(type(receipt.get(k)) is not int or receipt[k] < 0 for k in counts):
        raise ValueError('invalid backfill receipt: invalid counts')
    workflows = receipt.get('by_workflow')
    if not isinstance(workflows, list) or not workflows or any(
        not isinstance(w, dict) or not isinstance(w.get('repo'), str) or not isinstance(w.get('workflow'), str)
        or any(type(w.get(k)) is not int or w[k] < 0 for k in ('runs', 'attempts', 'jobs'))
        for w in workflows
    ) or any(sum(w[k] for w in workflows) != receipt[total] for k, total in zip(('runs', 'attempts', 'jobs'), counts)):
        raise ValueError('invalid backfill receipt: workflow counts do not match')
    if not isinstance(receipt.get('manifest_sha256'), str) or len(receipt['manifest_sha256']) != 64 or any(c not in '0123456789abcdef' for c in receipt['manifest_sha256']):
        raise ValueError('invalid backfill receipt: manifest hash')
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
            'status': receipt['status'], 'manifest': receipt.get('manifest'),
            'manifest_sha256': receipt['manifest_sha256'],
            'window_start_utc': receipt['window_start_utc'], 'window_end_exclusive_utc': receipt['window_end_exclusive_utc'],
            'event': receipt['event'], **{k: receipt[k] for k in counts}, 'by_workflow': workflows,
            'scope': '仅本地核验的 8月1日 manifest PR run 范围；不证明整日、整月或三个月完整。',
            'remaining_scope': '2026-08-02 至 2026-09-07 共37日未发现或未恢复，覆盖未知。'}


def coverage_summary(report):
    rows = report.get('coverage_audit', [])
    observed = sum(bool(row.get('runs')) for row in rows)
    return f'覆盖审计：{len(rows)} 个 workflow × 日单元中 {observed} 个观察到 run；未观察到不等于零活动，已观察也不证明完整。'


def backfill_summary(provenance):
    receipt = provenance.get('backfill', {})
    if isinstance(receipt, dict) and receipt.get('status') == 'verified_complete_for_manifest_pr_scope':
        return (f"补采证明报告：8月1日 manifest PR 范围已核验 {receipt['restored_runs']} runs、"
                f"{receipt['restored_attempts']} attempts、{receipt['restored_jobs']} jobs；"
                '仅限该范围，不代表整日、整月或三个月完整。8月2日至9月7日其余37日未发现或未恢复，覆盖未知。'
                '补采可能造成观测突峰，不能将其直接解释为增长。')
    return '未提供补采证明；不能据此判断是否补采或断言覆盖完整。'


def make_report(buckets, audit, issues, provenance, allow, cutoff):
    coverage = defaultdict(int)
    for row in audit:
        if row['runs']:
            coverage[row['repo'], row['date']] += 1
    series, monthly = {}, {}
    for group in ['ALL', *sorted(allow)]:
        repos = list(allow) if group == 'ALL' else [group]
        points = []
        months = {}
        for day in DAYS:
            bs = [buckets[r, day] for r in repos]
            models, counts, queues = defaultdict(float), Counter(), []
            conclusions = defaultdict(float)
            jobs = 0
            for b in bs:
                for model, amount in b['models'].items():
                    models[model] += amount
                for share, amount in b['conclusions'].items():
                    conclusions[share] += amount
                counts.update(b['attempts'])
                queues.extend(b['queues'])
                jobs += len(b['card_jobs'])
            n = sum(counts.values())
            total = sum(models.values()) if jobs else None
            by_conclusion = {k: conclusions[k] for k in ('success', 'failure', 'cancelled', 'other')} if jobs else None
            effective = conclusions['success'] + conclusions['failure'] if jobs else None
            cancelled = conclusions['cancelled'] if jobs else None
            points.append({'date': day, 'card_hours_by_model': dict(models) if jobs else None,
                           'card_hours': total, 'card_hours_by_conclusion': by_conclusion,
                           'effective_card_hours': effective, 'cancelled_card_hours': cancelled,
                           'card_job_day_samples': jobs,
                           'queue_n': len(queues), 'queue_p50_min': percentile(queues, .5),
                           'queue_p90_min': percentile(queues, .9), 'queue_total_hours': sum(queues) / 60 if queues else None,
                           'queue_sparse': 0 < len(queues) < 10,
                           'attempt_n': n, 'attempts': {k: counts[k] for k in ('success', 'failure', 'cancelled', 'other', 'nonterminal')} if n else None,
                           'observed_workflows': sum(coverage[r, day] for r in repos),
                           'allowlisted_workflows': sum(len(allow[r]) for r in repos)})
            mo = months.setdefault(day[:7], {'queues': [], 'card': [], 'effective': [], 'cancelled': [], 'failure': [], 'success': [], 'attempts': []})
            mo['queues'].extend(queues)
            if jobs:
                mo['card'].append(total)
                mo['effective'].append(effective)
                mo['cancelled'].append(cancelled)
                mo['failure'].append(conclusions['failure'])
                mo['success'].append(conclusions['success'])
            if n:
                mo['attempts'].append(n)
        for field in ('card_hours', 'queue_p50_min', 'queue_p90_min', 'attempt_n', 'effective_card_hours', 'cancelled_card_hours'):
            vals = [p[field] if field != 'attempt_n' or p[field] else None for p in points]
            for p, mean in zip(points, rolling(vals, DAYS, cutoff)):
                p[field + '_mean7'] = mean
        series[group] = points
        rows = []
        for m in sorted(months):
            mo = months[m]
            y, mm = int(m[:4]), int(m[5:7])
            card_sum = sum(mo['card'])
            rows.append({'month': m, 'complete': datetime(y + (mm == 12), mm % 12 + 1, 1, tzinfo=UTC) <= cutoff,
                         'card_sample_days': len(mo['card']), 'attempt_sample_days': len(mo['attempts']), 'queue_n': len(mo['queues']),
                         'card_hours_total': card_sum if mo['card'] else None,
                         'card_hours_per_day': card_sum / len(mo['card']) if mo['card'] else None,
                         'effective_card_hours_total': sum(mo['effective']) if mo['card'] else None,
                         'effective_card_hours_per_day': sum(mo['effective']) / len(mo['card']) if mo['card'] else None,
                         'cancelled_card_hours_total': sum(mo['cancelled']) if mo['card'] else None,
                         'failure_card_hours_total': sum(mo['failure']) if mo['card'] else None,
                         'success_card_hours_total': sum(mo['success']) if mo['card'] else None,
                         'cancelled_ratio': sum(mo['cancelled']) / card_sum if mo['card'] and card_sum else None,
                         'queue_p50_min': percentile(mo['queues'], .5) if mo['queues'] else None,
                         'attempt_per_day': sum(mo['attempts']) / len(mo['attempts']) if mo['attempts'] else None})
        monthly[group] = rows
    for pts in series.values():
        for p in pts:
            if p['card_hours_by_conclusion'] is not None:
                assert math.isclose(sum(p['card_hours_by_conclusion'].values()), p['card_hours'], rel_tol=1e-9, abs_tol=1e-6), \
                    (p['date'], sum(p['card_hours_by_conclusion'].values()), p['card_hours'])
    return {'provenance': provenance, 'issues': issues, 'series': series, 'monthly': monthly, 'coverage_audit': audit,
            'definitions': {'coverage_anchor': 'run.created_at UTC; observed runs do not prove complete collection',
                            'metric_anchors': 'card hours execution intersection; queue job.created_at; attempts run_started_at',
                            'rolling': 'arithmetic mean of seven consecutive daily values, null if any day null or current day incomplete',
                            'effective_vs_cancelled': '有效卡时=成功+失败作业占用的卡时；取消浪费=作业被取消前占用的卡时（硬件确实被占用，非“未使用”）；其余非 skipped 终态（如 timed_out）计入 other；有效+取消+other=总卡时',
                            'interpretation': '总卡时下降可能来自浪费消除（取消占比下降）或覆盖缩减（样本/覆盖变少），需结合取消占比与 attempt 面板判断；取消占比高说明大量卡时最终未产出结果',
                            'monthly_table': '月度汇总：卡时/天、有效卡时/天、attempt/天 为月内“有样本日”的均值，无样本日为未知，不计入也不按零处理；取消浪费/失败/成功占比=对应结论卡时/总卡时，衡量结构而非绝对量；点击表头可排序；排队P50=月内全部排队样本合并后取P50（比日均P50均值更准）；带*月份为部分月',
                            'scope': 'native PR-event attempts/jobs, no PR links or legacy fallback; all run creation dates',
                            'issues_scope': 'NPU jobs with queue creation or execution intersecting window; undated NPU attempts only when their run, attempt or job is window-relevant; categories may overlap' }}


def render(report):
    data = json.dumps(report, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    explanation = html.escape(backfill_summary(report.get('provenance', {})) + ' ' + coverage_summary(report))
    # Dynamic last-month note: a month is complete only if end_exclusive reaches the first day of the following month.
    end_exclusive = dt(report.get('provenance', {}).get('end_exclusive_utc')) or END
    last_day = min((end_exclusive - timedelta(days=1)).date(), (END - timedelta(days=1)).date())
    next_month_start = datetime(last_day.year + (last_day.month == 12), last_day.month % 12 + 1, 1, tzinfo=UTC)
    month_note = f'{last_day.month}月为完整月' if end_exclusive >= next_month_start else f'{last_day.month}月截至快照，为部分月'
    return '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NPU 日趋势</title><style>
:root{color-scheme:light dark;--bg:#f4f6fa;--fg:#172337;--panel:#fff;--grid:#cbd5e1;--muted:#52647c;--mean:#111827}*{box-sizing:border-box}body{margin:auto;max-width:1600px;padding:24px;background:var(--bg);color:var(--fg);font:14px system-ui}h1{font-size:28px}p{line-height:1.6}section{background:var(--panel);padding:16px;margin:16px 0;border-radius:12px;overflow:auto}svg{width:100%;min-width:850px;height:260px}text{fill:var(--muted);font-size:11px}.grid{stroke:var(--grid);stroke-width:1}.month{stroke:#f59e0b;stroke-dasharray:4 3}select{padding:8px}table{border-collapse:collapse}td,th{padding:6px;border:1px solid var(--grid);text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}.legend{display:flex;flex-wrap:wrap;gap:8px 18px;overflow-wrap:anywhere}.legend span{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0}.swatch{width:13px;height:13px;flex:none}.mean-swatch{width:22px;border-top:3px dashed var(--mean);flex:none}.mean-solid-swatch{width:22px;border-top:3px solid var(--mean);flex:none}.sparse-swatch{width:13px;height:13px;border:2px solid var(--fg);border-radius:50%;flex:none}td.num{text-align:right;font-variant-numeric:tabular-nums}@media(prefers-color-scheme:dark){:root{--bg:#101722;--fg:#e1e9f5;--panel:#192536;--grid:#40516a;--muted:#b6c4d6;--mean:#fff}}</style>
<h1>NPU 日趋势 · 2026年8–11月 UTC</h1><p><strong>已观测子集，不是全社区总量或利用率。</strong> ''' + explanation + ''' 当前 allowlist 并非历史有效日期证明；无匹配 run、无样本及未覆盖为未知而非零。''' + month_note + '''；每日可按社区筛选，底部逐 workflow × 日审计。不同型号卡时不可视为等效算力；合计只是物理卡时，不是利用率。</p><p>三个时间锚点不同：执行区间 [start,end) 拆日的 completed 非 skipped、数量已知 NPU job；job created→started 排队按 created 日（n&lt;10 稀疏）；有 NPU 证据的原生 attempt 按 run_started 日。无时间不借 run。虚线是连续7日每日值算术均值；有任一 null 或当天不完整即断线。面板 1b 按作业结论拆分卡时：有效卡时=成功+失败作业占用；取消浪费=作业被取消前占用的卡时（硬件确实被占用）；有效+取消+other=总卡时。总卡时下降可能来自浪费消除或覆盖缩减，需结合取消占比与 attempt 面板判断。覆盖轨道仅为 run 创建日观察情况，不证明采集完整。</p><label>社区 <select id="community"></select></label><p id="context"></p>
<section><h2>1 · 物理卡时 / 型号</h2><div class="legend" id="card-legend"></div><svg id="card"></svg></section><section><h2>1b · 卡时：有效 vs 取消浪费（按作业结论）</h2><div class="legend" id="cardconcl-legend"></div><svg id="cardconcl"></svg></section><section><h2>2 · 排队 P50 / P90（分钟）</h2><div class="legend" id="queue-legend"></div><svg id="queue"></svg></section><section><h2>3 · NPU-evidence attempt 结论</h2><div class="legend" id="attempt-legend"></div><svg id="attempt"></svg></section><section><h2>月度汇总</h2><div id="monthly"></div><p>卡时/天、有效卡时/天、attempt/天 为月内有样本日的均值，无样本日为未知，不计入也不按零处理；取消浪费/失败/成功占比=对应结论卡时/总卡时，衡量结构而非绝对量；点击表头可排序；排队P50 为月内全部排队样本合并后取P50，比日均P50均值更准；取消占比高说明大量卡时最终未产出结果。</p></section><section><h2>覆盖轨道</h2><svg id="coverage"></svg><p>深色表示当日观察到的白名单 workflow 数；浅色表示无 run 证据，不能断言零活动。任一观察值仍可能漏采。</p></section><section><h2>逐 workflow 日审计</h2><p>按 run.created 日归属，不等同上面三个指标的日归属。zero-job 不证明漏采；missing prior attempts 仅按已观察的最大序号计算。</p><div id="audit"></div></section><section><h2>当前社区的证据与排除原因</h2><p>计数可重叠；candidate_jobs 为窗口相关 run 的全部 jobs，window_jobs 为创建或执行与窗口相关的 jobs；unknown/conflict 并非 NPU。有效时间仅指 completed、非 skipped 且起止时间有效，卡时还需数量和型号。零 NPU 证据不等于无活动，也不推测型号；缺失采集参见下方逐 workflow 审计。</p><pre id="issues"></pre></section><section><h2>快照、证据与规则</h2><pre id="meta"></pre></section><script id="data" type="application/json">''' + data + '''</script><script>
const R=JSON.parse(document.getElementById('data').textContent), NS='http://www.w3.org/2000/svg', colors=['#2563eb','#ef4444','#10b981','#a855f7','#f59e0b','#06b6d4','#ec4899','#84cc16','#64748b','#f97316'];
const sel=document.getElementById('community'); Object.keys(R.series).forEach(k=>sel.add(new Option(k==='ALL'?'全部社区（可能缺口）':k,k)));
const conclColors={success:'#10b981',failure:'#ef4444',cancelled:'#f59e0b',other:'#64748b'};
function element(name,attrs,parent){const e=document.createElementNS(NS,name);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));parent.appendChild(e);return e}
function legend(id,items){const box=document.getElementById(id+'-legend');box.replaceChildren();for(const [label,color,type] of items){const item=document.createElement('span'),swatch=document.createElement('i');swatch.className=type==='mean'?'mean-swatch':type==='mean-solid'?'mean-solid-swatch':type==='sparse'?'sparse-swatch':'swatch';if(color){if(type==='mean'||type==='mean-solid')swatch.style.borderTopColor=color;else swatch.style.background=color}item.append(swatch,document.createTextNode(label));box.appendChild(item)}}
function businessTooltip(p,kind){
const fmt=(v,unit='',digits=2)=>v===null||v===undefined?'无样本/未知':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:digits})+unit;
const labels={success:'成功',failure:'失败',cancelled:'取消',other:'其他',nonterminal:'未结束'};
const rows=[p.date+'（UTC）'];
if(kind==='card'||kind==='cardconcl'){
rows.push('总卡时：'+fmt(p.card_hours,' 卡时'));
const parts=kind==='card'?p.card_hours_by_model:p.card_hours_by_conclusion;
Object.entries(parts||{}).forEach(([k,v])=>rows.push((labels[k]||k)+'：'+fmt(v,' 卡时')));
if(kind==='card')rows.push('总卡时 7日均值：'+fmt(p.card_hours_mean7,' 卡时'));
else{rows.push('有效卡时 7日均值：'+fmt(p.effective_card_hours_mean7,' 卡时'));rows.push('取消浪费 7日均值：'+fmt(p.cancelled_card_hours_mean7,' 卡时'))}
}
if(kind==='card'||kind==='cardconcl'||kind==='queue'){
rows.push('排队 P50：'+fmt(p.queue_p50_min,' 分钟'),'排队 P90：'+fmt(p.queue_p90_min,' 分钟'),'排队样本数：'+fmt(p.queue_n,' 个作业',0));
if(kind==='queue')rows.push('排队 P50 7日均值：'+fmt(p.queue_p50_min_mean7,' 分钟'),'排队 P90 7日均值：'+fmt(p.queue_p90_min_mean7,' 分钟'));
if(p.queue_sparse)rows.push('样本少于10个，分位数仅供参考');
}
if(kind==='attempt'){
rows.push('NPU 作业尝试总数：'+fmt(p.attempts?p.attempt_n:null,' 次',0));
Object.entries(p.attempts||{}).forEach(([k,v])=>rows.push((labels[k]||k)+'：'+fmt(v,' 次',0)));
rows.push('尝试次数 7日均值：'+fmt(p.attempt_n_mean7,' 次'));
}
if(kind==='coverage')rows.push('观察到的工作流：'+fmt(p.observed_workflows,' 个',0),'白名单工作流：'+fmt(p.allowlisted_workflows,' 个',0),'仅表示已观测范围，不证明采集完整');
return rows.join(String.fromCharCode(10));
}
function plot(id,points,kind){const svg=document.getElementById(id);svg.replaceChildren();svg.setAttribute('viewBox','0 0 1200 260');let left=48,top=14,w=1130,h=205,days=points.length,dx=w/days;let keys=kind==='card'?[...new Set(points.flatMap(p=>Object.keys(p.card_hours_by_model||{})))].sort():kind==='cardconcl'?['success','failure','cancelled','other']:['success','failure','cancelled','other','nonterminal'];let value=p=>kind==='card'||kind==='cardconcl'?p.card_hours:kind==='attempt'?(p.attempts?p.attempt_n:null):kind==='coverage'?p.observed_workflows:p.queue_p90_min;let ymax=Math.max(1,...points.map(p=>value(p)||0));
for(let i=0;i<=4;i++){let y=top+h-i*h/4;element('line',{x1:left,x2:left+w,y1:y,y2:y,class:'grid'},svg);let t=element('text',{x:2,y:y+4},svg);t.textContent=(ymax*i/4).toFixed(1)}
[0,31,61,92].forEach((n,i)=>{let x=left+n*dx;element('line',{x1:x,x2:x,y1:top,y2:top+h,class:'month'},svg);let t=element('text',{x:x+3,y:top+h+17},svg);t.textContent=['08-01','09-01','10-01','11-01'][i]});element('line',{x1:left+(days-1)*dx,x2:left+(days-1)*dx,y1:top,y2:top+h,class:'month'},svg);element('text',{x:left+(days-1)*dx+3,y:top+h+17},svg).textContent=points[days-1].date.slice(5);
points.forEach((p,i)=>{let x=left+i*dx,v=value(p);if(v===null){element('rect',{x,y:top,width:dx,height:h,fill:'#94a3b8',opacity:'.12'},svg);let hit=element('rect',{x,y:top,width:dx,height:h,fill:'transparent'},svg);element('title',{},hit).textContent=businessTooltip(p,kind);return}if(kind==='card'||kind==='cardconcl'||kind==='attempt'){let obj=kind==='card'?p.card_hours_by_model:kind==='cardconcl'?p.card_hours_by_conclusion:p.attempts,base=0;keys.forEach((k,j)=>{let v=obj[k]||0;let bh=v/ymax*h;if(bh>0){let rect=element('rect',{x,y:top+h-(base+v)/ymax*h,width:Math.max(1,dx-1),height:bh,fill:kind==='cardconcl'?conclColors[k]:colors[j%colors.length]},svg);element('title',{},rect).textContent=p.date+' '+k+': '+v.toFixed(2)}base+=v})}else if(kind==='coverage'){let rect=element('rect',{x,y:top+h-v/ymax*h,width:dx-1,height:v/ymax*h,fill:'#0d9488'},svg);element('title',{},rect).textContent=p.date+' observed '+v+'/'+p.allowlisted_workflows}let hit=element('rect',{x,y:top,width:dx,height:h,fill:'transparent'},svg);element('title',{},hit).textContent=businessTooltip(p,kind)});
if(kind==='card'||kind==='attempt')legend(id,[...keys.map((k,i)=>[k,colors[i%colors.length]]),['总量 7日均线',null,'mean']]);if(kind==='cardconcl')legend(id,[...keys.map(k=>[k,conclColors[k]]),['有效卡时 7日均线（实线）','#2563eb','mean-solid'],['取消浪费 7日均线（虚线）','#f59e0b','mean']]);if(kind==='queue')legend(id,[['P50','#2563eb'],['P90','#ef4444'],['同色虚线：7日均线',null,'mean'],['空心大圆：n<10',null,'sparse']]);let lines=kind==='queue'?[['queue_p50_min','#2563eb',false],['queue_p90_min','#ef4444',false],['queue_p50_min_mean7','#2563eb',true],['queue_p90_min_mean7','#ef4444',true]]:kind==='card'?[['card_hours_mean7','var(--mean)',true]]:kind==='cardconcl'?[['effective_card_hours_mean7','#2563eb',false],['cancelled_card_hours_mean7','#f59e0b',true]]:kind==='attempt'?[['attempt_n_mean7','var(--mean)',true]]:[];lines.forEach(([key,color,dash])=>{let path='',open=false;points.forEach((p,i)=>{let v=p[key];if(v===null||v===undefined){open=false;return}let x=left+(i+.5)*dx,y=top+h-v/ymax*h;path+=(open?' L':' M')+x+','+y;open=true});element('path',{d:path,fill:'none',stroke:color,'stroke-width':dash?2.5:1.5,'stroke-dasharray':dash?'4 3':'none'},svg);if(kind==='queue'&&!dash)points.forEach((p,i)=>{let v=p[key];if(v===null||v===undefined)return;let c=element('circle',{cx:left+(i+.5)*dx,cy:top+h-v/ymax*h,r:p.queue_sparse?5:3,fill:p.queue_sparse?'var(--panel)':color,stroke:color,'stroke-width':p.queue_sparse?2.5:1},svg);element('title',{},c).textContent=businessTooltip(p,kind)})}) }
function sortableTable(id){const t=document.getElementById(id);if(!t)return;t.querySelectorAll('th').forEach((th,i)=>{th.style.cursor='pointer';th.title='点击排序';th.onclick=()=>{const rows=[...t.querySelectorAll('tbody tr')];const asc=th.dataset.asc!=='1';t.querySelectorAll('th').forEach(x=>delete x.dataset.asc);th.dataset.asc=asc?'1':'';rows.sort((a,b)=>{const va=(a.cells[i].dataset.v??a.cells[i].textContent).trim(),vb=(b.cells[i].dataset.v??b.cells[i].textContent).trim();const na=parseFloat(va.replace(/,/g,'')),nb=parseFloat(vb.replace(/,/g,''));const isNum=x=>/^[-+]?[\\d,.]+%?$/.test(x);if(isNum(va)&&isNum(vb)&&!isNaN(na)&&!isNaN(nb))return asc?na-nb:nb-na;if(va==='—')return 1;if(vb==='—')return -1;return asc?va.localeCompare(vb):vb.localeCompare(va)});const tb=t.querySelector('tbody');rows.forEach(r=>tb.appendChild(r))}})}
function show(){let group=sel.value,p=R.series[group];['card','cardconcl','queue','attempt','coverage'].forEach(k=>plot(k,p,k));let mo=R.monthly&&R.monthly[group]||[];const fnum=(v,d=1)=>v===null||v===undefined?'—':v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});let mt='<table id="monthly-table"><thead><tr><th>月份</th><th>卡时/天</th><th>取消浪费占比</th><th>有效卡时/天</th><th>失败占比</th><th>成功占比</th><th>排队P50(min)</th><th>attempt/天</th></tr></thead><tbody>';const pctOf=(num,den)=>num===null||num===undefined||!den?'—':(num/den*100).toFixed(1)+'%';for(const r of mo)mt+='<tr><td>'+r.month+(r.complete?'':'*')+'</td><td class="num" title="月内 '+r.card_sample_days+' 个有样本日；卡时合计 '+fnum(r.card_hours_total)+'">'+fnum(r.card_hours_per_day)+'</td><td class="num" title="取消卡时合计 '+fnum(r.cancelled_card_hours_total)+' / 卡时合计 '+fnum(r.card_hours_total)+'">'+(r.cancelled_ratio===null||r.cancelled_ratio===undefined?'—':(r.cancelled_ratio*100).toFixed(1)+'%')+'</td><td class="num" title="有效卡时合计 '+fnum(r.effective_card_hours_total)+'">'+fnum(r.effective_card_hours_per_day)+'</td><td class="num" title="失败卡时合计 '+fnum(r.failure_card_hours_total)+' / 卡时合计 '+fnum(r.card_hours_total)+'">'+pctOf(r.failure_card_hours_total,r.card_hours_total)+'</td><td class="num" title="成功卡时合计 '+fnum(r.success_card_hours_total)+' / 卡时合计 '+fnum(r.card_hours_total)+'">'+pctOf(r.success_card_hours_total,r.card_hours_total)+'</td><td class="num" title="月内全部 '+r.queue_n+' 个排队样本合并P50">'+fnum(r.queue_p50_min,2)+'</td><td class="num" title="月内 '+r.attempt_sample_days+' 个有 attempt 日">'+fnum(r.attempt_per_day)+'</td></tr>';document.getElementById('monthly').innerHTML=mt+'</tbody></table>'+(mo.some(r=>!r.complete)?'<p>* 部分月（截至快照）。</p>':'');document.getElementById('context').textContent='快照 '+R.provenance.snapshot_utc+'；结束（不含）'+R.provenance.end_exclusive_utc+'；空白阴影为无样本/未知。';document.getElementById('issues').textContent=JSON.stringify(group==='ALL'?R.issues.total:R.issues.by_repo[group],null,2);let rows=R.coverage_audit.filter(r=>group==='ALL'||r.repo===group);let table='<table id="audit-table"><thead><tr><th>repo</th><th>workflow</th><th>UTC日</th><th>runs</th><th>attempts</th><th>jobs</th><th>missing attempt runs</th><th>missing prior attempts</th><th>zero-job attempts</th><th>collection</th></tr></thead><tbody>';const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));for(const r of rows)table+='<tr>'+['repo','workflow','date','runs','attempts','jobs','missing_attempt_runs','missing_prior_attempts','zero_job_attempts','collection'].map(k=>'<td>'+esc(r[k])+'</td>').join('')+'</tr>';document.getElementById('audit').innerHTML=table+'</tbody></table>';sortableTable('monthly-table');sortableTable('audit-table')}sel.onchange=show;document.getElementById('meta').textContent=JSON.stringify({provenance:R.provenance,issues:R.issues,definitions:R.definitions},null,2);show();</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, help='new HTML output; JSON shares its stem')
    parser.add_argument('--backfill-receipt', type=Path, help='optional verified first-day manifest PR receipt')
    args = parser.parse_args()
    backfill = load_backfill_receipt(args.backfill_receipt)
    config = ROOT / 'config/drilldown-workflows.yaml'
    allow = {r['repo']: sorted({w['file'] for w in r['workflows']}) for r in yaml.safe_load(config.read_text())['repositories']}
    url = os.getenv('PG_DATABASE_URL') or load_env(ROOT / '.env').get('PG_DATABASE_URL') or DEFAULT_PG_URL
    db = PostgresClient(url)
    try:
        db._conn = db._pg8000.connect(**db._parse_dsn(url))
        cur = db._conn.cursor()
        cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cur.execute("SET LOCAL statement_timeout = '30s'")
        cur.execute("SELECT transaction_timestamp(), current_setting('transaction_read_only'), current_setting('transaction_isolation')")
        snapshot, ro, isolation = cur.fetchone()
        if (ro, isolation) != ('on', 'repeatable read'):
            raise RuntimeError('unsafe transaction')
        cutoff = min(END, dt(snapshot))
        ids = {r['repo']: r['id'] for r in db.query("SELECT id, owner || '/' || repo AS repo FROM repos")}
        rows = []
        for repo, files in allow.items():
            if repo not in ids:
                continue
            marks = ','.join(['%s'] * len(files))
            rows.extend(db.query(f'''SELECT %s AS repo, COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow,
              r.id AS run_id, r.created_at, a.run_attempt, a.status AS attempt_status, a.conclusion AS attempt_conclusion,
              a.run_started_at AS attempt_started_at, a.jobs_fetched_at,
              j.job_id, j.status AS job_status, j.conclusion AS job_conclusion, j.created_at AS job_created_at,
              j.started_at, j.completed_at, j.labels_json, j.resource_model, j.resource_count
              FROM runs r LEFT JOIN workflow_attempts a ON a.run_id=r.id
              LEFT JOIN workflow_jobs j ON j.run_id=a.run_id AND j.run_attempt=a.run_attempt
              WHERE r.repo_id=%s AND r.event='pull_request'
              AND COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) IN ({marks})
              AND {CANDIDATE_SQL}''', (repo, ids[repo], *files, START, cutoff, START, cutoff, START, cutoff, cutoff, START)))
        buckets, audit, issues = aggregate(rows, allow, cutoff)
        provenance = {'snapshot_utc': dt(snapshot).isoformat(), 'start_inclusive_utc': START.isoformat(), 'end_exclusive_utc': cutoff.isoformat(), 'read_only': ro, 'isolation': isolation, 'statement_timeout': '30s', 'allowlist_sha256': sha(config), 'script_sha256': sha(Path(__file__)), 'rule_version': RULE_VERSION, 'rule_source': RULE_SOURCE, 'rule_sha256': {n: sha(SKILL / 'scripts' / n) for n in ('card_quantity.py', 'runner_resource_evidence.py')}, 'backfill': backfill, 'missing_repos': sorted(set(allow) - set(ids))}
    finally:
        db.close()
    report = make_report(buckets, audit, issues, provenance, allow, cutoff)
    out = args.out or ROOT / 'reports' / f'npu-daily-trends-{snapshot:%Y%m%dT%H%M%SZ}.html'
    json_path = out.with_suffix('.json')
    if out == json_path or out.exists() or json_path.exists():
        raise FileExistsError('refusing to overwrite output')
    out.parent.mkdir(parents=True, exist_ok=True)
    with json_path.open('x', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, separators=(',', ':'))
    with out.open('x', encoding='utf-8') as f:
        f.write(render(report))
    print(json.dumps({'html': str(out), 'json': str(json_path), 'snapshot': provenance['snapshot_utc'], 'rows': len(rows), 'issues': issues}, ensure_ascii=False))


if __name__ == '__main__':
    main()
