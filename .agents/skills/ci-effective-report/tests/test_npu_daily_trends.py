from datetime import datetime, timezone
import json
import math

import pytest

from scripts.npu_daily_trends import START, END, DAYS, CANDIDATE_SQL, aggregate, make_report, rolling, split_hours
from scripts.runner_resource_evidence import resource_evidence

UTC = timezone.utc


def test_split_month_midnight_zero_negative_and_half_card():
    assert split_hours('2026-08-31T23:00:00Z', '2026-09-01T01:00:00Z', .5, END) == [('2026-08-31', .5), ('2026-09-01', .5)]
    assert split_hours('2026-08-31T23:00:00Z', '2026-09-01T00:00:00Z', 1, END) == [('2026-08-31', 1)]
    assert split_hours('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 1, END) == [('2026-08-01', 0)]
    assert split_hours('2026-08-01T01:00:00Z', '2026-08-01T00:00:00Z', 1, END) is None
    assert split_hours(None, '2026-08-01T00:00:00Z', 1, END) is None
    assert resource_evidence({'labels_json': '["linux-aarch64-a3-1"]'})[2] == .5


def test_rolling_consecutive_and_incomplete():
    values = [1.] * 10
    cutoff = datetime(2026, 8, 9, 12, tzinfo=UTC)
    result = rolling(values, DAYS[:10], cutoff)
    assert result[6:9] == [1, 1, None]
    values[3] = None
    assert rolling(values, DAYS[:10], END)[6:10] == [None] * 4


def test_native_queue_reruns_dedup_and_coverage():
    allow = {'x/y': ['ci.yml']}
    base = {'repo': 'x/y', 'workflow': 'ci.yml', 'run_id': 7, 'created_at': '2026-07-31T23:00:00Z',
            'run_attempt': 2, 'attempt_status': 'completed', 'attempt_conclusion': 'failure',
            'attempt_started_at': '2026-08-02T00:00:00Z', 'job_id': 42, 'job_status': 'completed',
            'job_conclusion': 'success', 'job_created_at': '2026-08-01T00:00:00Z',
            'started_at': '2026-08-01T00:10:00Z', 'completed_at': '2026-08-01T01:10:00Z',
            'labels_json': '["linux-aarch64-a3-1"]'}
    rerun = {**base, 'run_attempt': 3, 'job_id': 43, 'attempt_conclusion': 'success', 'attempt_started_at': None,
             'job_created_at': None, 'started_at': None, 'completed_at': None}
    current = {**base, 'run_id': 8, 'run_attempt': 2, 'job_id': None, 'created_at': '2026-08-03T00:00:00Z'}
    buckets, audit, issues = aggregate([base, base.copy(), rerun, current], allow, END)
    assert buckets['x/y', '2026-08-01']['queues'] == [10]
    assert buckets['x/y', '2026-08-01']['models']['linux-aarch64-a3'] == .5
    assert buckets['x/y', '2026-08-02']['attempts']['failure'] == 1
    assert issues['total']['npu_attempts_undated'] == 0
    assert len(audit) == len(DAYS)  # 2026-08-01..11-08 window: 100 day cells
    row = next(r for r in audit if r['date'] == '2026-08-03')
    assert (row['runs'], row['attempts'], row['zero_job_attempts'], row['missing_prior_attempts']) == (1, 1, 1, 1)
    assert sum(r['runs'] for r in audit) == 1
    report = make_report(buckets, audit, issues, {}, allow, END)
    p = report['series']['x/y']
    assert p[0]['queue_n'] == 1 and p[0]['queue_p50_min'] == 10 and p[0]['queue_sparse']
    assert p[1]['attempts']['failure'] == 1 and p[1]['attempts']['success'] == 0
    assert p[3]['attempts'] is None and p[3]['card_hours'] is None
    assert p[0]['card_hours_by_conclusion'] == {'success': .5, 'failure': 0, 'cancelled': 0, 'other': 0}
    assert p[0]['effective_card_hours'] == .5 and p[0]['cancelled_card_hours'] == 0
    assert p[3]['card_hours_by_conclusion'] is None and p[3]['effective_card_hours'] is None
    m = report['monthly']['x/y'][0]
    assert m['month'] == '2026-08' and m['complete'] and m['card_hours_per_day'] == .5
    assert m['cancelled_ratio'] == 0 and m['queue_p50_min'] == 10 and m['queue_n'] == 1
    assert m['attempt_per_day'] == 1 and m['attempt_sample_days'] == 1


def job_row(jid, conclusion, started, completed):
    return {'repo': 'x/y', 'workflow': 'ci.yml', 'run_id': 1, 'created_at': '2026-08-01T00:00:00Z',
            'run_attempt': 1, 'attempt_status': 'completed', 'attempt_conclusion': 'cancelled',
            'attempt_started_at': '2026-08-01T00:00:00Z', 'job_id': jid, 'job_status': 'completed',
            'job_conclusion': conclusion, 'job_created_at': '2026-08-01T00:00:00Z',
            'started_at': started, 'completed_at': completed, 'labels_json': '["linux-aarch64-a3-1"]'}


def test_card_conclusion_split_matches_card_hours_and_monthly_ratio():
    allow = {'x/y': ['ci.yml']}
    rows = [job_row(1, 'success', '2026-08-01T00:00:00Z', '2026-08-01T02:00:00Z'),
            job_row(2, 'failure', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z'),
            job_row(3, 'cancelled', '2026-08-01T00:00:00Z', '2026-08-01T04:00:00Z'),
            job_row(4, 'timed_out', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z'),
            job_row(5, 'skipped', None, None)]
    buckets, audit, issues = aggregate(rows, allow, END)
    assert buckets['x/y', '2026-08-01']['conclusions'] == {'success': 1.0, 'failure': .5, 'cancelled': 2.0, 'other': .5}
    report = make_report(buckets, audit, issues, {}, allow, END)
    p = report['series']['x/y'][0]
    assert p['card_hours'] == 4.0
    assert p['card_hours_by_conclusion'] == {'success': 1.0, 'failure': .5, 'cancelled': 2.0, 'other': .5}
    assert math.isclose(sum(p['card_hours_by_conclusion'].values()), p['card_hours'])
    assert p['effective_card_hours'] == 1.5 and p['cancelled_card_hours'] == 2.0
    assert p['effective_card_hours_mean7'] is None  # window incomplete on the first day
    m = report['monthly']['x/y'][0]
    assert m['card_hours_total'] == 4.0 and m['card_hours_per_day'] == 4.0
    assert m['cancelled_ratio'] == .5 and m['effective_card_hours_per_day'] == 1.5
    assert m['card_sample_days'] == 1 and m['queue_n'] == 4 and m['queue_p50_min'] == 0
    assert issues['total']['job_skipped'] == 1


def test_undated_attempts_scoped_per_repo_and_cross_window_execution():
    allow = {'x/y': ['ci.yml'], 'z/w': ['ci.yml']}
    base = {'repo': 'x/y', 'workflow': 'ci.yml', 'run_id': 1, 'created_at': '2020-01-01T00:00:00Z',
            'run_attempt': 1, 'attempt_started_at': None, 'job_id': 1, 'job_status': 'completed',
            'job_conclusion': 'success', 'job_created_at': None, 'started_at': None, 'completed_at': None,
            'labels_json': '["linux-aarch64-a3-1"]'}
    crossing = {**base, 'run_id': 2, 'job_id': 2, 'started_at': '2026-07-31T23:00:00Z',
                'completed_at': '2026-08-01T01:00:00Z'}
    undated = {**base, 'repo': 'z/w', 'run_id': 3, 'created_at': '2026-08-02T00:00:00Z'}
    buckets, audit, issues = aggregate([base, crossing, undated], allow, END)
    assert buckets['x/y', '2026-08-01']['models']['linux-aarch64-a3'] == .5
    assert issues['by_repo']['x/y']['npu_attempts_undated'] == 1
    assert issues['by_repo']['z/w']['npu_attempts_undated'] == 1
    assert issues['total']['npu_attempts_undated'] == 2
    assert issues['by_repo']['x/y']['execution_valid'] == 1


def test_candidate_sql_window_and_crossing():
    import sqlite3
    db = sqlite3.connect(':memory:')
    db.executescript('''CREATE TABLE runs(id INTEGER, created_at TEXT);
      CREATE TABLE workflow_attempts(run_id INTEGER, run_attempt INTEGER, run_started_at TEXT);
      CREATE TABLE workflow_jobs(run_id INTEGER, run_attempt INTEGER, created_at TEXT, started_at TEXT, completed_at TEXT);''')
    db.executemany('INSERT INTO runs VALUES (?, ?)', [(1, '2020-01-01'), (2, '2020-01-01'),
                   (3, '2026-08-02'), (4, '2020-01-01'), (5, '2020-01-01'), (6, '2020-01-01')])
    db.executemany('INSERT INTO workflow_attempts VALUES (?, 1, ?)', [(1, None), (2, None), (4, '2026-08-02'), (5, None), (6, None)])
    db.executemany('INSERT INTO workflow_jobs VALUES (?, 1, ?, ?, ?)', [
        (1, None, None, None), (2, None, '2026-07-31', '2026-08-02'),
        (5, '2026-08-02', None, None), (6, None, '2026-07-01', '2026-07-02')])
    start, end = '2026-08-01', '2026-11-01'
    sql = 'SELECT r.id FROM runs r WHERE ' + CANDIDATE_SQL.replace('%s', '?')
    assert [r[0] for r in db.execute(sql, (start, end, start, end, start, end, end, start))] == [2, 3, 4, 5]


def test_render_has_html_legends_and_queue_points():
    from scripts.npu_daily_trends import render
    page = render({'series': {}, 'coverage_audit': [], 'issues': {'total': {}, 'by_repo': {}}, 'provenance': {}, 'definitions': {}})
    assert 'id="queue-legend"' in page and 'id="card-legend"' in page and 'id="cardconcl-legend"' in page
    assert 'id="monthly"' in page and '月度汇总' in page and '取消浪费占比' in page
    assert "p.card_hours_by_conclusion" in page and 'effective_card_hours_mean7' in page and 'cancelled_card_hours_mean7' in page
    assert "element('circle'" in page and 'p.queue_sparse?5:3' in page
    assert 'var(--mean)' in page and 'R.issues.by_repo[group]' in page
    assert '未提供补采证明' in page and 'BLOCKED' not in page


def test_business_tooltip_values_and_missing_data():
    import subprocess
    from scripts.npu_daily_trends import render
    page = render({'series': {}, 'coverage_audit': [], 'issues': {}, 'provenance': {}})
    helper = 'function businessTooltip' + page.split('function businessTooltip', 1)[1].split('function plot', 1)[0]
    script = helper + '''
const p={date:'2026-08-01',queue_p50_min:0,queue_p90_min:12.5,queue_n:5,queue_sparse:true,
card_hours:100,card_hours_by_model:{A2:100},attempt_n:2,attempts:{success:2},observed_workflows:0,allowlisted_workflows:10};
console.log(JSON.stringify(['queue','card','cardconcl','attempt','coverage'].map(k=>businessTooltip(p,k))));
'''
    tips = json.loads(subprocess.check_output(['node', '-e', script], text=True))
    assert '2026-08-01（UTC）' in tips[0]
    assert '排队 P50：0 分钟' in tips[0] and '排队 P90：12.5 分钟' in tips[0]
    assert '排队样本数：5 个作业' in tips[0] and '样本少于10个' in tips[0]
    assert '排队 P50 7日均值：无样本/未知' in tips[0]
    assert '总卡时：100 卡时' in tips[1] and 'A2：100 卡时' in tips[1]
    assert '排队 P90：12.5 分钟' in tips[1]
    assert '有效卡时 7日均值：无样本/未知' in tips[2]
    assert '成功：2 次' in tips[3]
    assert '观察到的工作流：0 个' in tips[4]
    assert 'JSON.stringify(p,null,2)' not in page
    assert "element('title',{},c).textContent=businessTooltip(p,kind)" in page


def receipt_data():
    return {'status': 'verified_complete_for_manifest_pr_scope', 'manifest_sha256': 'a' * 64,
            'window_start_utc': '2026-08-01T00:00:00Z', 'window_end_exclusive_utc': '2026-08-02T00:00:00Z',
            'event': 'pull_request', 'pending_manifest_pr_runs': 0, 'pending_intent': False,
            'restored_runs': 1, 'restored_attempts': 2, 'restored_jobs': 3,
            'by_workflow': [{'repo': '</script><script>alert(1)</script>', 'workflow': 'a.yml',
                             'runs': 1, 'attempts': 2, 'jobs': 3}]}


def test_receipt_and_render_escaped(tmp_path):
    import hashlib
    from scripts.npu_daily_trends import load_backfill_receipt, render
    path = tmp_path / 'receipt.json'
    path.write_text(json.dumps(receipt_data()), encoding='utf-8')
    receipt = load_backfill_receipt(path)
    assert receipt['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert receipt['status'] == 'verified_complete_for_manifest_pr_scope'
    page = render({'series': {}, 'coverage_audit': [{'runs': 1}, {'runs': 0}],
                   'issues': {}, 'provenance': {'backfill': receipt}, 'definitions': {}})
    assert '其余37日' in page and '不能将其直接解释为增长' in page
    assert '2 个 workflow × 日单元中 1 个' in page
    assert '</script><script>alert(1)</script>' not in page
    assert '\\u003c/script>' in page
    assert 'BLOCKED' not in page


@pytest.mark.parametrize('change', [
    {'status': 'failed'}, {'pending_intent': True}, {'pending_manifest_pr_runs': False},
    {'window_start_utc': '2026-08-02T00:00:00Z'}, {'restored_runs': 0},
    {'by_workflow': []}, {'manifest_sha256': 'x' * 64},
])
def test_invalid_receipt_rejected(tmp_path, change):
    from scripts.npu_daily_trends import load_backfill_receipt
    path = tmp_path / 'receipt.json'
    path.write_text(json.dumps({**receipt_data(), **change}))
    with pytest.raises(ValueError):
        load_backfill_receipt(path)


def test_missing_and_malformed_receipt(tmp_path):
    from scripts.npu_daily_trends import load_backfill_receipt
    assert load_backfill_receipt(None)['status'] == 'not_provided'
    path = tmp_path / 'broken.json'
    path.write_text('{')
    with pytest.raises(ValueError):
        load_backfill_receipt(path)
    with pytest.raises(FileNotFoundError):
        load_backfill_receipt(tmp_path / 'missing.json')
