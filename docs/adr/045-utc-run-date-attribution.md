# ADR-045: UTC attribution for runs.date

## Status

Accepted (2026-11-26)

## Context

`runs.date` was derived in `collect.ts` with `format(new Date(run.created_at), 'yyyy-MM-dd')` — date-fns formats in the **host-local** timezone, and the hourly collector runs on a MST host. Any run created between 00:00 and 07:00 UTC was therefore filed under the previous calendar day. Discovered on 2026-11-26 during the PR #309 review: 77,001 of 302,665 stored runs (25.4%) had a `date` differing from the UTC date of their `created_at`, which made "runs on date X" actually mean a Denver-day window (cutting at ~17:00–18:00 UTC), skewed daily counts at boundaries against GitHub `created` filters, and invalidated "is day X complete" checks by up to 7 hours.

Every stored `created_at` value carries an explicit UTC offset (verified across all 302,665 rows), so the correction is unambiguous.

## Decision

1. Derive run date keys in UTC via the exported `runDateKey()` helper (`new Date(ms).toISOString().slice(0, 10)`), never via host-local formatting. Unparseable input falls back to the legacy `Invalid Date` string rather than throwing mid-collection.
2. Migrate stored data once:
   ```sql
   UPDATE runs
      SET date = to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    WHERE date <> to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD');
   ```
   The statement is idempotent and safe to re-run.
3. Leave collection **window-edge** labels (retention start, "today", created-filter cursors) on host-local time: they only slide the fetch boundary by the offset and overlap safely with ETag-cached windows; converting them would change collector behavior beyond the data bug being fixed here.

## Consequences

- "Date X" now means the true UTC calendar day everywhere `runs.date` is used (dashboard tabs, `ci_analyze.py` reports, retention pruning).
- Daily counts shift by up to one day for the ~25% of runs previously filed early; aggregate monthly stats are effectively unchanged (the window slides by the timezone offset at both ends).
- `collection_state` retained-date lists self-heal on the next sweeps (the state merges dates computed by `runDateKey`); retention keeps at most one extra day of shifted runs during the transition.
- Cross-checks against GitHub `created` filters now align without boundary noise; the PR #309 review's "2 missing LlamaFactory runs" were this boundary effect, not missing data.
- `backfill-missing-jobs.ts` `since` boundary remains host-local; it widens the backfill window by at most the offset, which is the safe direction.
