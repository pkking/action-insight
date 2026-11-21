from scripts.npu_efficiency import aggregate, duration

ALLOW = {'vllm-project/vllm-ascend': ['pr_test.yaml'], 'empty/repo': ['ci.yml']}
BASE = {'repo': 'vllm-project/vllm-ascend', 'workflow': 'pr_test.yaml', 'run_id': 1,
        'created_at': '2026-08-31T23:59:59Z', 'run_attempt': 1, 'job_id': 10,
        'job_status': 'completed', 'job_conclusion': 'success',
        'job_created_at': '2026-08-31T22:00:00Z', 'started_at': '2026-08-31T22:30:00Z',
        'completed_at': '2026-08-31T23:30:00Z', 'labels_json': '["linux-aarch64-a3-4-"]',
        'resource_model': None, 'resource_count': None}


def row(**kwargs):
    return {**BASE, **kwargs}


def result(rows, cutoff='2026-10-30T00:00:00Z'):
    return {(x['repo'], x['month']): x for x in aggregate(rows, ALLOW, cutoff)}


def test_native_without_links_rerun_and_model_hours():
    a = result([row(), row(run_attempt=2, job_id=11, pr_link=None), row(job_id=12, labels_json='["linux-aarch64-a2b1-1-hk-001"]')])[BASE['repo'], '2026-08']
    assert (a['runs'], a['native_attempts'], a['npu_evidence_attempts'], a['npu_jobs']) == (1, 2, 2, 3)
    assert a['card_hours_by_model']['linux-aarch64-a3']['card_hours'] == 4
    assert a['card_hours_by_model']['linux-aarch64-a2b1']['card_hours'] == 1
    assert (a['queue_samples'], a['queue_p50_minutes'], a['queue_p90_minutes']) == (3, 30, 30)


def test_missing_attempt_zero_jobs_and_empty():
    r = result([row(run_id=2, run_attempt=None, job_id=None), row(run_id=3, job_id=None)])
    a = r[BASE['repo'], '2026-08']
    assert (a['missing_attempt_runs'], a['zero_job_attempts'], a['native_attempts']) == (1, 1, 1)
    assert r['empty/repo', '2026-08']['runs'] is None
    assert r['empty/repo', '2026-08']['card_hours_by_model'] is None


def test_end_31st_and_snapshot_exclusive():
    r = result([row(), row(run_id=2, created_at='2026-10-29T23:59:59Z'),
                row(run_id=3, created_at='2026-10-30T00:00:00Z'),
                row(run_id=4, created_at='2026-07-31T23:59:59Z')])
    assert r[BASE['repo'], '2026-08']['runs'] == 1
    assert r[BASE['repo'], '2026-10']['runs'] == 1


def test_zero_negative_time_and_execution_states():
    assert duration('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z') == 0
    assert duration('2026-08-01T01:00:00Z', '2026-08-01T00:00:00Z') is None
    a = result([row(completed_at=BASE['started_at'], job_created_at=BASE['started_at']),
                row(job_id=11, completed_at='2026-08-31T21:00:00Z'),
                row(job_id=12, job_conclusion='skipped'), row(job_id=13, job_status='in_progress')])[BASE['repo'], '2026-08']
    assert a['npu_card_hour_samples'] == 1
    assert a['card_hours_by_model']['linux-aarch64-a3']['card_hours'] == 0
    assert (a['npu_bad_execution_time_jobs'], a['npu_skipped_jobs'], a['npu_nonterminal_jobs']) == (1, 1, 1)
