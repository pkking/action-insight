from datetime import datetime, timedelta, timezone

from scripts.npu_waste_superseded import (
    BOT_LOGINS,
    CANCEL_WINDOW,
    analyze,
    classify_attempt,
    is_bot_login,
    is_superseded,
    waste_hours,
)

UTC = timezone.utc
T0 = datetime(2026, 8, 1, 8, tzinfo=UTC)


def make_att(status='completed', conclusion='cancelled', end=T0 + timedelta(hours=2), pr_eff=None, pr_id=None,
             cancelled_by=None, cancel_probed=False, cancel_evidence=None):
    # cancelled_by/cancel_probed default to "not yet probed by the ADR-040 collector";
    # legacy classification tests are unaffected since unprobed cancels stay unknown.
    return {'status': status, 'conclusion': conclusion, 'end_dt': end,
            'end': end.isoformat() if end else None, 'hours': 1.0, 'npu_jobs': 1, 'all_jobs': 1,
            'shares': {}, 'pr_id': pr_id, 'pr_eff': pr_eff, 'dup_key': ('r', 'w', 'old'),
            'repo': 'r', 'workflow': 'w', 'run_id': 1, 'run_attempt': 1, 'runtime_seconds': 7200,
            'cancelled_by': cancelled_by, 'cancel_probed': cancel_probed, 'cancel_evidence': cancel_evidence}


def make_run(sha='old', branch='feat/x', created=T0):
    return {'id': 1, 'sha': sha, 'branch': branch, 'created': created.isoformat(), 'created_dt': created}


def make_cand(run_id=2, sha='new', created=None, pr_id=None, pr_eff=None):
    # Default sits 5 minutes before the attempt end: inside the cancel window.
    created = created or T0 + timedelta(hours=2) - timedelta(minutes=5)
    return {'run_id': run_id, 'sha': sha, 'created': created.isoformat(), 'created_dt': created,
            'pr_id': pr_id, 'pr_eff': pr_eff, 'event': 'pull_request'}


def test_superseded_same_pr_identity():
    att, run = make_att(pr_eff=10), make_run()
    cand = make_cand(pr_id=10, pr_eff=10)
    assert classify_attempt(att, run, [cand], {}, 1, True, {})[0] == 'superseded'
    assert is_superseded(att, run, [cand], {}) is cand


def test_superseded_branch_fallback_without_pr_identity():
    att, run = make_att(), make_run()
    assert classify_attempt(att, run, [make_cand()], {}, 1, True, {})[0] == 'superseded'


def test_branch_collision_excluded():
    # Candidate linked to a different PR: branch-name collision, not a superseder.
    att, run = make_att(pr_eff=10), make_run()
    assert classify_attempt(att, run, [make_cand(pr_id=11, pr_eff=11)], {}, 1, True, {})[0] == 'cancelled_unknown'
    # Candidate's PR branch differs from the old run's branch while old identity is unknown.
    att2, run2 = make_att(), make_run()
    assert classify_attempt(att2, run2, [make_cand(pr_id=99, pr_eff=99)],
                            {99: 'other/branch'}, 1, True, {})[0] == 'cancelled_unknown'


def test_cancel_window_rejects_slow_cancellation():
    att, run = make_att(), make_run()
    late = make_cand(created=att['end_dt'] - CANCEL_WINDOW - timedelta(minutes=1))
    assert classify_attempt(att, run, [late], {}, 1, True, {})[0] == 'cancelled_unknown'
    inside = make_cand(created=att['end_dt'] - CANCEL_WINDOW + timedelta(minutes=1))
    assert classify_attempt(att, run, [inside], {}, 1, True, {})[0] == 'superseded'


def test_merge_cleanup_window():
    merged = T0 + timedelta(hours=1)
    # Cancelled 10 minutes after merge: inside [merged-5min, merged+30min].
    att = make_att(end=merged + timedelta(minutes=10), pr_eff=7)
    assert classify_attempt(att, make_run(), [], {}, 1, True, {7: merged})[0] == 'merge_cleanup'
    # Just before the bracket opens or long after it closes: unknown.
    early = make_att(end=merged - timedelta(minutes=6), pr_eff=7)
    assert classify_attempt(early, make_run(), [], {}, 1, True, {7: merged})[0] == 'cancelled_unknown'
    late = make_att(end=merged + timedelta(minutes=31), pr_eff=7)
    assert classify_attempt(late, make_run(), [], {}, 1, True, {7: merged})[0] == 'cancelled_unknown'
    # Superseded outranks merge cleanup.
    both = make_att(end=merged + timedelta(minutes=10), pr_eff=7)
    assert classify_attempt(both, make_run(), [make_cand(created=merged + timedelta(minutes=5))], {}, 1, True, {7: merged})[0] == 'superseded'


def test_same_sha_and_earlier_candidates_are_not_superseders():
    att, run = make_att(), make_run()
    assert classify_attempt(att, run, [make_cand(sha='old')], {}, 1, True, {})[0] == 'cancelled_unknown'
    # Candidate queued before the old run was even created cannot have cancelled it.
    assert classify_attempt(att, run, [make_cand(created=T0 - timedelta(minutes=5))], {}, 1, True, {})[0] == 'cancelled_unknown'


def test_duplicate_keeper_rules():
    att, run = make_att(status='completed', conclusion='success'), make_run()
    assert classify_attempt(att, run, [], {}, 2, False, {})[0] == 'duplicate'
    assert classify_attempt(att, run, [], {}, 2, True, {})[0] == 'normal'
    # Superseded outranks duplicate for a cancelled non-keeper run.
    att2 = make_att()
    assert classify_attempt(att2, run, [make_cand()], {}, 2, False, {})[0] == 'superseded'


def test_natural_completion_is_not_waste():
    # Old run finished normally before the newer run started: user-confirmed not waste.
    att = make_att(status='completed', conclusion='success')
    assert classify_attempt(att, make_run(), [], {}, 1, True, {})[0] == 'normal'


def test_missing_end_or_branch_stays_unknown():
    assert is_superseded(make_att(end=None), make_run(), [make_cand()], {}) is None
    nobranch = make_run(branch=None)
    assert is_superseded(make_att(), nobranch, [make_cand()], {}) is None


def test_explicit_cancel_human():
    att = make_att(cancelled_by='octocat', cancel_probed=True, cancel_evidence='job_annotation')
    assert classify_attempt(att, make_run(), [], {}, 1, True, {})[0] == 'explicit_cancel_human'
    result = analyze([att], {1: make_run()}, {}, {}, {}, {}, {})
    assert result['causes']['explicit_cancel_human']['hours'] == 1.0
    # Waste accounting (ADR-039 + ADR-040): explicit cancels count as waste.
    assert waste_hours(result['causes']) == 1.0
    assert result['explicit_cancel_attempts'] == [
        {**{k: v for k, v in result['explicit_cancel_attempts'][0].items()}, 'canceller': 'octocat'}]
    assert result['explicit_cancel_attempts'][0]['evidence'] == 'job_annotation'


def test_explicit_cancel_bot_suffix():
    att = make_att(cancelled_by='github-actions[bot]', cancel_probed=True, cancel_evidence='job_annotation')
    assert classify_attempt(att, make_run(), [], {}, 1, True, {})[0] == 'explicit_cancel_bot'
    assert is_bot_login('github-actions[bot]')


def test_explicit_cancel_bot_allowlist():
    assert 'sglang-npu-bot' in BOT_LOGINS
    # Case-insensitive match on the curated allowlist.
    att = make_att(cancelled_by='SGLang-NPU-Bot', cancel_probed=True, cancel_evidence='check_run_annotation')
    assert is_bot_login('SGLang-NPU-Bot')
    assert classify_attempt(att, make_run(), [], {}, 1, True, {})[0] == 'explicit_cancel_bot'


def test_priority_over_duplicate():
    run = make_run()
    # Cancelled non-keeper with a canceller: explicit cancel wins over duplicate.
    att = make_att(cancelled_by='octocat', cancel_probed=True)
    assert classify_attempt(att, run, [], {}, 2, False, {})[0] == 'explicit_cancel_human'
    # Superseded still outranks explicit cancel.
    superseded_att = make_att(cancelled_by='octocat', cancel_probed=True)
    assert classify_attempt(superseded_att, run, [make_cand()], {}, 2, False, {})[0] == 'superseded'
    # Merge cleanup still outranks explicit cancel.
    merged = T0 + timedelta(hours=1)
    cleanup_att = make_att(end=merged + timedelta(minutes=10), pr_eff=7,
                           cancelled_by='octocat', cancel_probed=True)
    assert classify_attempt(cleanup_att, run, [], {}, 1, True, {7: merged})[0] == 'merge_cleanup'


def test_unprobed_stays_unknown():
    # Neither a probed system cancel nor an unprobed attempt may be counted as waste.
    unprobed = make_att()
    assert unprobed['cancelled_by'] is None and not unprobed['cancel_probed']
    assert classify_attempt(unprobed, make_run(), [], {}, 1, True, {})[0] == 'cancelled_unknown'
    probed = make_att(cancel_probed=True, cancel_evidence='none')
    assert classify_attempt(probed, make_run(), [], {}, 1, True, {})[0] == 'cancelled_unknown'


def test_analyze_cancellers_and_coverage():
    human1 = make_att(cancelled_by='octocat', cancel_probed=True, cancel_evidence='job_annotation')
    human3 = make_att(cancelled_by='octocat', cancel_probed=True)
    human3['hours'] = 3.0
    bot = make_att(cancelled_by='github-actions[bot]', cancel_probed=True, cancel_evidence='job_annotation')
    probed_none = make_att(cancel_probed=True, cancel_evidence='none')
    unprobed = make_att()
    result = analyze([human1, human3, bot, probed_none, unprobed], {1: make_run()}, {}, {}, {}, {}, {})
    assert result['causes']['explicit_cancel_human']['attempts'] == 2
    assert result['causes']['explicit_cancel_bot']['attempts'] == 1
    assert result['causes']['cancelled_unknown']['attempts'] == 2
    # Top canceller lists: human and bot split, sorted by hours descending.
    assert result['cancel_cancellers']['human'] == [{'login': 'octocat', 'hours': 4.0, 'attempts': 2}]
    assert result['cancel_cancellers']['bot'] == [{'login': 'github-actions[bot]', 'hours': 1.0, 'attempts': 1}]
    assert result['explicit_cancel_attempts'][0]['npu_card_hours'] == 3.0
    coverage = result['classification_coverage']['cancelled_attempts']
    assert coverage['explicit_cancel'] == 3
    assert coverage['probed_no_canceller'] == 1
    assert coverage['unprobed'] == 1
    # cancelled_unknown_attempts is the collector's member list (membership-only).
    assert {(e['repo'], e['run_id'], e['run_attempt'], e['runtime_seconds'])
            for e in result['cancelled_unknown_attempts']} == {('r', 1, 1, 7200)}
    assert waste_hours(result['causes']) == 5.0  # human 4h + bot 1h; unknown excluded
