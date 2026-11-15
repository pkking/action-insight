#!/usr/bin/env python3
"""Read-only NPU waste accounting: superseded, duplicate-SHA and explicit-cancel
card hours.

Cause categories (user-confirmed 2026-11 scope, see docs/adr/039 and ADR-040):
- superseded: a PR-event attempt of an older head_sha was cancelled while a
  different-sha run of the same PR (linked) or same head_branch + workflow was
  already queued (created). Branch fallback covers runs without PR links; a
  candidate proven to belong to a different PR is excluded (fork branch-name
  collision guard). Waste = all executed NPU card hours of that attempt.
- duplicate: the same (repo, workflow, head_sha) was triggered more than once
  (PR event). The latest-created run is the keeper; the other runs' executed
  NPU card hours are waste, listed separately.
- explicit_cancel_human / explicit_cancel_bot: a cancelled attempt whose check-run
  annotation names the canceller (ADR-040 collection fills
  workflow_attempts.cancelled_by). Bots are logins ending in '[bot]' or listed in
  BOT_LOGINS. Waste = all executed NPU card hours, listed per canceller.
Cancelled attempts without superseding/merge-cleanup/explicit-canceller evidence
stay 'cancelled_unknown' — including attempts the ADR-040 collector has not probed
yet (unprobed is not zero) — and are NOT counted as waste. Runs that finished
before the newer run started are not waste.
Priority: superseded > merge_cleanup > explicit_cancel > duplicate, so each
attempt has exactly one cause.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
import yaml
from scripts.card_quantity import RULE_SOURCE, RULE_VERSION
from scripts.ci_analyze import DEFAULT_PG_URL, PostgresClient, load_env
from scripts.npu_daily_trends import END, START, dt, sha, split_hours
from scripts.runner_resource_evidence import resource_evidence

UTC = START.tzinfo
# Sibling runs just outside the window still prove supersede/duplicate relations;
# their hours stay clamped to [START, cutoff) by split_hours.
WIDEN = timedelta(days=14)
# GitHub concurrency cancel-in-progress kills the old run within seconds of the new
# run being queued; a longer gap means the cancellation probably had another cause.
CANCEL_WINDOW = timedelta(minutes=30)
# Merge cleanup: PR merged and the attempt was cancelled within this bracket of merged_at.
MERGE_BEFORE = timedelta(minutes=5)
MERGE_AFTER = timedelta(minutes=30)
CAUSES = ('superseded', 'merge_cleanup', 'explicit_cancel_human', 'explicit_cancel_bot', 'duplicate', 'cancelled_unknown', 'normal')
# Explicit-bot logins without the '[bot]' suffix (ADR-040); extend after each
# collection batch following the canceller top lists, with human confirmation.
# Named automation accounts (no [bot] suffix): confirmed non-human actors.
# vllm-ascend-ci: vllm-ascend CI automation account (no profile, name pattern, repo automation).
# metamergebot: merge automation account.
BOT_LOGINS = {'sglang-npu-bot', 'vllm-ascend-ci', 'metamergebot'}
# Waste tiers (ADR-039 + ADR-040); each attempt's hours go to exactly one cause.
WASTE_CAUSES = ('superseded', 'merge_cleanup', 'explicit_cancel_human', 'explicit_cancel_bot', 'duplicate')


def is_bot_login(login: str) -> bool:
    """Bot iff the login carries the GitHub '[bot]' suffix or is explicitly allowlisted."""
    return login.endswith('[bot]') or login.lower() in BOT_LOGINS


def waste_hours(causes) -> float:
    """Sum of waste-tier hours; cancelled_unknown and normal are excluded by definition."""
    return sum(causes[cause]['hours'] for cause in WASTE_CAUSES)


def is_superseded(att, run, candidates, pr_branch):
    """Return the matched superseding sibling, or None; PR identity guards collisions."""
    end = att.get('end_dt')
    if not end or not run['sha'] or not run['created_dt'] or not run['branch']:
        return None
    for c in candidates:
        if c['run_id'] == run['id'] or not c['sha'] or c['sha'] == run['sha']:
            continue
        if not (run['created_dt'] < c['created_dt'] <= end):
            continue
        if end - c['created_dt'] > CANCEL_WINDOW:
            continue
        # Both PR identities known and different -> branch-name collision, not a superseder.
        if c['pr_eff'] and att['pr_eff'] and c['pr_eff'] != att['pr_eff']:
            continue
        # Candidate linked to a PR whose branch differs -> different PR, exclude.
        if c['pr_id'] and not att['pr_eff'] and pr_branch.get(c['pr_id']) != run['branch']:
            continue
        return c
    return None


def is_merge_cleanup(att, pr_merged):
    """PR merged and the cancellation brackets merged_at: hard evidence of merge cleanup."""
    merged = pr_merged.get(att['pr_eff'])
    return bool(merged and att['end_dt'] and merged - MERGE_BEFORE <= att['end_dt'] <= merged + MERGE_AFTER)


def classify_attempt(att, run, candidates, pr_branch, dup_size, keeper, pr_merged):
    """Pure cause classification; returns (cause, matched_superseder_or_None)."""
    cancelled = att['status'] == 'completed' and att['conclusion'] == 'cancelled'
    if cancelled:
        matched = is_superseded(att, run, candidates, pr_branch)
        if matched:
            return 'superseded', matched
        if is_merge_cleanup(att, pr_merged):
            return 'merge_cleanup', None
        # ADR-040: explicit canceller from check-run annotations. Attempts the
        # collector has not probed have cancelled_by=None and stay unknown — never
        # guessed as system cancels.
        who = att.get('cancelled_by')
        if who:
            return ('explicit_cancel_bot' if is_bot_login(who) else 'explicit_cancel_human'), None
    if not keeper and dup_size > 1:
        return 'duplicate', None
    if cancelled:
        return 'cancelled_unknown', None
    return 'normal', None


def analyze(attempts, runs, cands_by_run, pr_branch, dup_index, pr_numbers, pr_merged):
    """Assign each attempt one cause and aggregate hours; keep result-account context."""
    by_run = defaultdict(list)
    for att in attempts:
        by_run[att['run_id']].append(att)
    keepers = {}
    for run_ids in dup_index.values():
        best = max(run_ids, key=lambda r: (runs[r]['created'] or '', r))
        for rid in run_ids:
            keepers[rid] = rid == best
    per_repo = defaultdict(lambda: {c: {'hours': 0.0, 'attempts': 0, 'runs': set()} for c in CAUSES})
    result_hours = defaultdict(float)
    listings = defaultdict(list)
    cancellers = {'human': defaultdict(lambda: {'hours': 0.0, 'attempts': 0}),
                  'bot': defaultdict(lambda: {'hours': 0.0, 'attempts': 0})}
    coverage = defaultdict(lambda: defaultdict(int))
    superseded_evidence = defaultdict(lambda: {'hours': 0.0, 'attempts': 0})
    for att in attempts:
        for share, hours in att['shares'].items():
            result_hours[share] += hours
        run = runs[att['run_id']]
        cause, matched = classify_attempt(att, run, cands_by_run.get(att['run_id'], ()), pr_branch,
                                           len(dup_index.get(att['dup_key'], ())), keepers.get(att['run_id'], True), pr_merged)
        per_repo[att['repo']][cause]['hours'] += att['hours']
        per_repo[att['repo']][cause]['attempts'] += 1
        per_repo[att['repo']][cause]['runs'].add(att['run_id'])
        if att['status'] == 'completed' and att['conclusion'] == 'cancelled':
            coverage['cancelled_attempts']['total'] += 1
            coverage['cancelled_attempts']['with_pr_identity' if att['pr_eff'] else 'without_pr_identity'] += 1
            coverage['cancelled_attempts']['superseded' if cause in ('superseded', 'merge_cleanup') else 'not_superseded'] += 1
            # ADR-040: distinguish explicit cancels from probed system cancels and
            # from attempts the collector has not reached yet (unprobed is not zero).
            if cause in ('explicit_cancel_human', 'explicit_cancel_bot'):
                coverage['cancelled_attempts']['explicit_cancel'] += 1
            elif att.get('cancel_probed'):
                coverage['cancelled_attempts']['probed_no_canceller'] += 1
            else:
                coverage['cancelled_attempts']['unprobed'] += 1
        if cause in ('superseded', 'merge_cleanup', 'duplicate', 'explicit_cancel_human', 'explicit_cancel_bot'):
            if cause == 'superseded':
                evidence = 'pr' if att['pr_eff'] and matched['pr_eff'] and att['pr_eff'] == matched['pr_eff'] else 'branch'
                superseded_evidence[evidence]['hours'] += att['hours']
                superseded_evidence[evidence]['attempts'] += 1
            elif cause == 'merge_cleanup':
                evidence = 'merged_at'
            elif cause == 'duplicate':
                evidence = 'same_sha_group'
            else:
                evidence = att.get('cancel_evidence') or 'unknown'
            listings[cause].append({
                'repo': att['repo'], 'workflow': att['workflow'], 'run_id': att['run_id'],
                'run_attempt': att['run_attempt'], 'head_sha': run['sha'], 'head_branch': run['branch'],
                'pr_numbers': [n for n in [pr_numbers.get(att['pr_id'])] if n is not None],
                'run_created_utc': run['created'], 'attempt_end_utc': att.get('end'),
                'npu_card_hours': round(att['hours'], 2), 'npu_jobs': att['npu_jobs'], 'all_jobs': att['all_jobs'],
                'cancelled': att['status'] == 'completed' and att['conclusion'] == 'cancelled',
                'evidence': evidence,
                'canceller': att.get('cancelled_by'),
                'superseded_by_run_id': matched['run_id'] if matched else None,
                'superseded_by_sha': matched['sha'] if matched else None,
                'superseded_by_created_utc': matched['created'] if matched else None,
                'cancel_lag_min': round((att['end_dt'] - matched['created_dt']).total_seconds() / 60, 1) if matched and att['end_dt'] else None,
            })
            if cause in ('explicit_cancel_human', 'explicit_cancel_bot'):
                bucket = cancellers['bot' if cause == 'explicit_cancel_bot' else 'human'][att['cancelled_by']]
                bucket['hours'] += att['hours']
                bucket['attempts'] += 1
        elif cause == 'cancelled_unknown':
            # Member list + audit listing that feeds the ADR-040 collector
            # (--attempts-file); ordering/filtering/idempotency stay in SQL.
            listings['cancelled_unknown'].append({
                'repo': att['repo'], 'workflow': att['workflow'], 'run_id': att['run_id'],
                'run_attempt': att['run_attempt'], 'head_sha': run['sha'],
                'runtime_seconds': att['runtime_seconds'], 'npu_card_hours': round(att['hours'], 2),
            })
    dup_groups = []
    for (repo, wf, sha_), run_ids in sorted(dup_index.items()):
        if len(run_ids) < 2:
            continue
        ids = sorted(run_ids, key=lambda r: (runs[r]['created'] or '', r))
        dup_groups.append({'repo': repo, 'workflow': wf, 'head_sha': sha_, 'keeper_run_id': ids[-1],
                           'run_count': len(ids),
                           'runs': [{'run_id': rid, 'created_utc': runs[rid]['created'],
                                     'npu_card_hours': round(sum(a['hours'] for a in by_run[rid]), 2),
                                     'waste': rid != ids[-1]} for rid in ids]})
    totals = {cause: {'hours': round(sum(v[cause]['hours'] for v in per_repo.values()), 2),
                      'attempts': sum(v[cause]['attempts'] for v in per_repo.values()),
                      'runs': sum(len(v[cause]['runs']) for v in per_repo.values())} for cause in CAUSES}
    return {
        'result_account_card_hours': {k: round(v, 2) for k, v in sorted(result_hours.items())},
        'classification_coverage': {k: dict(v) for k, v in coverage.items()},
        'superseded_evidence': {k: {'hours': round(v['hours'], 2), 'attempts': v['attempts']}
                                for k, v in superseded_evidence.items()},
        'causes': totals,
        'by_repo': {repo: {cause: {'hours': round(v['hours'], 2), 'attempts': v['attempts'], 'runs': len(v['runs'])}
                           for cause, v in sorted(c.items())} for repo, c in sorted(per_repo.items())},
        'superseded_attempts': sorted(listings['superseded'], key=lambda x: -x['npu_card_hours']),
        'explicit_cancel_attempts': sorted(
            listings['explicit_cancel_human'] + listings['explicit_cancel_bot'], key=lambda x: -x['npu_card_hours']),
        'cancel_cancellers': {
            kind: [{'login': login, 'hours': round(v['hours'], 2), 'attempts': v['attempts']}
                   for login, v in sorted(entries.items(), key=lambda kv: (-kv[1]['hours'], kv[0]))[:10]]
            for kind, entries in cancellers.items()},
        'cancelled_unknown_attempts': sorted(listings['cancelled_unknown'], key=lambda x: -x['npu_card_hours']),
        'duplicate_groups': sorted(dup_groups, key=lambda g: -sum(r['npu_card_hours'] for r in g['runs'] if r['waste'])),
    }


def fetch(db, ids, allow, cutoff):
    """Read-only window query; returns attempts, run metadata and sibling indexes."""
    widened = (START - WIDEN).isoformat()
    attempts, runs, att_index = [], {}, {}
    pr_link, pr_fallback, pr_numbers, pr_branch = {}, {}, {}, {}
    pr_merged = {}
    sha_pr, pm_by_number = {}, {}
    by_branch, by_pr = defaultdict(list), defaultdict(list)
    for repo, files in allow.items():
        if repo not in ids:
            continue
        marks = ','.join(['%s'] * len(files))
        # 1. PR-event attempts + jobs in the allowlist scope (waste hours scope).
        for row in db.query(f'''SELECT %s AS repo, COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow,
          r.id AS run_id, r.head_sha, r.head_branch, r.created_at AS run_created,
          a.run_attempt, a.status AS attempt_status, a.conclusion AS attempt_conclusion,
          a.completed_at AS attempt_completed, a.runtime_seconds AS attempt_runtime_seconds,
          a.cancelled_by, a.cancel_evidence, a.cancel_annotation_fetched_at,
          j.job_id, j.status AS job_status, j.conclusion AS job_conclusion,
          j.started_at, j.completed_at, j.labels_json, j.resource_model, j.resource_count
          FROM runs r LEFT JOIN workflow_attempts a ON a.run_id=r.id
          LEFT JOIN workflow_jobs j ON j.run_id=a.run_id AND j.run_attempt=a.run_attempt
          WHERE r.repo_id=%s AND r.event='pull_request'
          AND COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) IN ({marks})
          AND r.created_at >= %s AND r.created_at < %s''', (repo, ids[repo], *files, widened, cutoff.isoformat())):
            rid, wf = row['run_id'], row['workflow']
            if rid not in runs:
                runs[rid] = {'id': rid, 'repo': repo, 'workflow': wf, 'sha': row['head_sha'],
                             'branch': row['head_branch'], 'created': row['run_created'],
                             'created_dt': dt(row['run_created'])}
            if row['run_attempt'] is None:
                continue
            key = (rid, row['run_attempt'])
            if key not in att_index:
                attempts.append({'repo': repo, 'workflow': wf, 'run_id': rid, 'run_attempt': row['run_attempt'],
                                 'status': row['attempt_status'], 'conclusion': row['attempt_conclusion'],
                                 'end': None, 'end_dt': None, 'hours': 0.0, 'npu_jobs': 0, 'all_jobs': 0,
                                 'shares': defaultdict(float), 'pr_id': None,
                                 'runtime_seconds': row['attempt_runtime_seconds'],
                                 'cancelled_by': row['cancelled_by'], 'cancel_evidence': row['cancel_evidence'],
                                 'cancel_probed': row['cancel_annotation_fetched_at'] is not None,
                                 'dup_key': (repo, wf, row['head_sha'])})
                att_index[key] = attempts[-1]
                aend = dt(row['attempt_completed'])
                if aend:
                    att_index[key]['end_dt'], att_index[key]['end'] = aend, aend.isoformat()
            att = att_index[key]
            jid = row['job_id']
            if jid is None:
                continue
            att['all_jobs'] += 1
            end = dt(row['completed_at'])
            if end and (att['end_dt'] is None or end > att['end_dt']):
                att['end_dt'], att['end'] = end, end.isoformat()
            if row['job_status'] != 'completed' or row['job_conclusion'] == 'skipped':
                continue
            js, je = dt(row['started_at']), dt(row['completed_at'])
            if js is None or je is None or je < js:
                continue
            kind, model, cards, _reason = resource_evidence(row)
            if kind != 'npu' or cards is None or model is None:
                continue
            att['npu_jobs'] += 1
            share = row['job_conclusion'] if row['job_conclusion'] in ('success', 'failure', 'cancelled') else 'other'
            for _day, hours in split_hours(js, je, cards, cutoff):
                att['hours'] += hours
                att['shares'][share] += hours
        # 2. Sibling runs of the same workflows, all events, for supersede evidence only.
        for row in db.query(f'''SELECT r.id AS run_id, COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow,
          r.head_sha, r.head_branch, r.created_at, r.event
          FROM runs r WHERE r.repo_id=%s
          AND COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) IN ({marks})
          AND r.created_at >= %s AND r.created_at < %s''', (ids[repo], *files, widened, cutoff.isoformat())):
            entry = {'run_id': row['run_id'], 'sha': row['head_sha'], 'created': row['created_at'],
                     'created_dt': dt(row['created_at']), 'pr_id': None, 'event': row['event']}
            runs.setdefault(row['run_id'], {'id': row['run_id'], 'repo': repo, 'workflow': row['workflow'],
                                            'sha': row['head_sha'], 'branch': row['head_branch'],
                                            'created': row['created_at'], 'created_dt': dt(row['created_at'])})
            if row['head_branch']:
                by_branch[repo, row['workflow'], row['head_branch']].append(entry)
        # 3. PR links (attempt-level preferred, run-level fallback) and PR metadata.
        for row in db.query('''SELECT pwa.run_id, pwa.run_attempt, pwa.pr_metric_id, pm.pr_number, pm.branch AS pr_branch, pm.merged_at
            FROM pr_workflow_attempts pwa JOIN pr_metrics pm ON pm.id=pwa.pr_metric_id
            WHERE pm.repo_id=%s''', (ids[repo],)):
            pr_link[(row['run_id'], row['run_attempt'])] = row['pr_metric_id']
            pr_numbers[row['pr_metric_id']] = row['pr_number']
            pr_branch[row['pr_metric_id']] = row['pr_branch']
            pr_merged[row['pr_metric_id']] = dt(row['merged_at']) if row.get('merged_at') else None
        for row in db.query('''SELECT pw.run_id, pw.pr_metric_id, pm.pr_number, pm.branch AS pr_branch, pm.merged_at
            FROM pr_workflows pw JOIN pr_metrics pm ON pm.id=pw.pr_metric_id
            WHERE pm.repo_id=%s''', (ids[repo],)):
            pr_fallback[row['run_id']] = row['pr_metric_id']
            pr_numbers[row['pr_metric_id']] = row['pr_number']
            pr_branch[row['pr_metric_id']] = row['pr_branch']
            pr_merged[row['pr_metric_id']] = dt(row['merged_at']) if row.get('merged_at') else None
        for row in db.query('''SELECT head_sha, pr_number FROM pr_resolution_cache
            WHERE repo_id=%s AND status='resolved' AND pr_number IS NOT NULL''', (ids[repo],)):
            sha_pr[repo, row['head_sha']] = row['pr_number']
        for row in db.query('SELECT id, pr_number FROM pr_metrics WHERE repo_id=%s', (ids[repo],)):
            pm_by_number[repo, row['pr_number']] = row['id']
    run_pr = {}
    for (rid, _num), pid in pr_link.items():
        run_pr[rid] = pid
    for rid, pid in pr_fallback.items():
        run_pr.setdefault(rid, pid)

    def pr_eff_of(rid, repo, sha):
        """Effective PR identity: links first, then sha->PR resolution cache."""
        pid = run_pr.get(rid)
        if pid:
            return pid
        num = sha_pr.get((repo, sha)) if sha else None
        return pm_by_number.get((repo, num)) if num is not None else None

    for entry_list in by_branch.values():
        for entry in entry_list:
            entry['pr_id'] = run_pr.get(entry['run_id'])
            repo = runs[entry['run_id']]['repo']
            entry['pr_eff'] = pr_eff_of(entry['run_id'], repo, entry['sha'])
    # by_pr index: PR-linked sibling runs for same-PR supersede detection.
    for entry_list in by_branch.values():
        for entry in entry_list:
            if entry['pr_id'] is not None:
                repo = runs[entry['run_id']]['repo']
                by_pr[repo, runs[entry['run_id']]['workflow'], entry['pr_id']].append(entry)
    for att in attempts:
        att['pr_id'] = pr_link.get((att['run_id'], att['run_attempt'])) or run_pr.get(att['run_id'])
        att['pr_eff'] = att['pr_id'] or pr_eff_of(att['run_id'], att['repo'], runs[att['run_id']]['sha'])
    cands_by_run, dup_index = defaultdict(list), defaultdict(set)
    for att in attempts:
        run = runs[att['run_id']]
        seen = set()
        for source in (by_pr.get((att['repo'], att['workflow'], att['pr_id'])) if att['pr_id'] else (),
                       by_branch.get((att['repo'], att['workflow'], run['branch'])) or ()):
            for entry in source:
                if entry['run_id'] not in seen:
                    seen.add(entry['run_id'])
                    cands_by_run[att['run_id']].append(entry)
        if run['sha'] is not None:
            dup_index[att['dup_key']].add(att['run_id'])
    return attempts, runs, cands_by_run, pr_branch, dup_index, pr_numbers, pr_merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, help='new JSON output path; refuses to overwrite')
    args = parser.parse_args()
    config = ROOT / 'config/drilldown-workflows.yaml'
    allow = {r['repo']: sorted({w['file'] for w in r['workflows']}) for r in yaml.safe_load(config.read_text())['repositories']}
    url = os.getenv('PG_DATABASE_URL') or load_env(ROOT / '.env').get('PG_DATABASE_URL') or DEFAULT_PG_URL
    db = PostgresClient(url)
    try:
        db._conn = db._pg8000.connect(**db._parse_dsn(url))
        cur = db._conn.cursor()
        cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cur.execute("SET LOCAL statement_timeout = '300s'")
        cur.execute("SELECT transaction_timestamp(), current_setting('transaction_read_only'), current_setting('transaction_isolation')")
        snapshot, ro, isolation = cur.fetchone()
        if (ro, isolation) != ('on', 'repeatable read'):
            raise RuntimeError('unsafe transaction')
        cutoff = min(END, dt(snapshot))
        ids = {r['repo']: r['id'] for r in db.query("SELECT id, owner || '/' || repo AS repo FROM repos")}
        attempts, runs, cands_by_run, pr_branch, dup_index, pr_numbers, pr_merged = fetch(db, ids, allow, cutoff)
    finally:
        db.close()
    result = analyze(attempts, runs, cands_by_run, pr_branch, dup_index, pr_numbers, pr_merged)
    known = sum(result['result_account_card_hours'].values())
    waste = waste_hours(result['causes'])
    result['provenance'] = {
        'snapshot_utc': dt(snapshot).isoformat(), 'start_inclusive_utc': START.isoformat(),
        'end_exclusive_utc': cutoff.isoformat(), 'read_only': ro, 'isolation': isolation,
        'allowlist_sha256': sha(config), 'script_sha256': sha(Path(__file__)),
        'rule_version': RULE_VERSION, 'rule_source': RULE_SOURCE,
        'bot_logins': sorted(BOT_LOGINS),
        'cause_rules': {
            'superseded': 'cancelled attempt of an older sha while a different-sha run of the same PR (linked) or same workflow+head_branch was queued at most 30 minutes before the cancellation (GitHub cancel-in-progress signature); all its executed NPU card hours count',
            'merge_cleanup': 'cancelled attempt whose PR merged and whose cancellation falls within [merged_at-5min, merged_at+30min]; hard evidence, counted as waste',
            'explicit_cancel_human': 'cancelled attempt whose workflow_attempts.cancelled_by is set to a non-bot login (ADR-040 check-run annotation "The run was canceled by @X."); counted as waste and listed per canceller',
            'explicit_cancel_bot': 'same as explicit_cancel_human but the login ends with [bot] or is in provenance.bot_logins; counted as waste and listed per canceller',
            'duplicate': 'same repo+workflow+head_sha triggered multiple times (PR event); latest-created run is keeper, others are waste, listed separately',
            'cancelled_unknown': 'cancelled without superseder / merge-cleanup evidence and without an explicit canceller (cancelled_by NULL); includes attempts the ADR-040 collector has not probed yet (unprobed, see classification_coverage) and probed system cancels; NOT counted as waste',
            'natural_completion': 'run finished before the newer run started; not waste (user-confirmed)',
            'priority': 'superseded > merge_cleanup > explicit_cancel > duplicate; each attempt has exactly one cause',
            'evidence_tiers': "superseded entries carry evidence='pr' (both PR identities resolved and equal) or 'branch' (same workflow+head_branch, PR identity unresolved; validated by the sub-minute cancel signature); explicit_cancel entries carry the collector's evidence ('job_annotation' or 'check_run_annotation')",
        },
        'caveats': ['observed runs only; an unobserved newer run makes supersede invisible (stays unknown, not zero)',
                    'branch-evidence tier is best-effort: PR links cover only ~20% of cancelled attempts and pr_resolution_cache adds little; same-named fork branches can collide, though the sub-minute cancel lag and different-PR exclusion guard keep the risk low',
                    'explicit_cancel coverage depends on the ADR-040 annotation collection; classification_coverage.cancelled_attempts.unprobed is the not-yet-probed residual and stays unknown — unprobed is not zero',
                    'bot detection only trusts the [bot] suffix and the curated bot allowlist (provenance.bot_logins); canceller top lists are an accounting view, not blame attribution',
                    'hours are NPU jobs with known quantity only; CPU and unknown-quantity jobs are excluded from hours but present in job counts',
                    'run selection widened 14 days before the window to observe sibling relations; hours stay clamped to the window',
                    'waste_share compares waste hours against known result-account hours; cancelled_unknown is excluded from the numerator by definition'],
    }
    result['summary'] = {
        'known_card_hours': round(known, 2),
        'waste_card_hours': round(waste, 2),
        'waste_share': round(waste / known, 4) if known else None,
        'superseded_card_hours': result['causes']['superseded']['hours'],
        'merge_cleanup_card_hours': result['causes']['merge_cleanup']['hours'],
        'duplicate_card_hours': result['causes']['duplicate']['hours'],
        'explicit_cancel_card_hours': round(result['causes']['explicit_cancel_human']['hours'] + result['causes']['explicit_cancel_bot']['hours'], 2),
        'explicit_cancel_human_card_hours': result['causes']['explicit_cancel_human']['hours'],
        'explicit_cancel_bot_card_hours': result['causes']['explicit_cancel_bot']['hours'],
        'cancelled_unknown_card_hours': result['causes']['cancelled_unknown']['hours'],
    }
    out = args.out or ROOT / 'reports' / f'npu-waste-superseded-{snapshot:%Y%m%dT%H%M%SZ}.json'
    if out.exists():
        raise FileExistsError('refusing to overwrite output')
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('x', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({'out': str(out), 'summary': result['summary'], 'causes': result['causes'],
                      'classification_coverage': result['classification_coverage'],
                      'result_account_card_hours': result['result_account_card_hours']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
