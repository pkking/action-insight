---
title: feat: Add monthly and daily CI experience report modes to ci-efficiency-report
type: feat
status: active
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-monthly-ci-experience-report-requirements.md
---

# feat: Add monthly and daily CI experience report modes to ci-efficiency-report

## Overview

Extend `.agents/skills/ci-efficiency-report` so it can produce both a management-ready monthly CI experience report and a daily technical diagnostic report for a single repository, while preserving enough workflow/job/step detail for actionable investigation (see origin: `docs/brainstorms/2026-04-19-monthly-ci-experience-report-requirements.md`).

## Problem Frame

The current skill and script can compute repo-level CI efficiency metrics, but the output is still shaped like a raw technical report and only reflects one reporting style. That is not enough for the user's target use case: one monthly report that presents PR submission experience to managers, and one daily report that highlights current technical problems for the team to improve and track. The local research also showed that GitHub's jobs API already exposes `workflow_name` and `steps`, so the main gap is not source data availability but the script's current aggregation model and report structure.

## Requirements Trace

- R1. Support at least two explicit report modes: `monthly_summary` and `daily_diagnostic`.
- R2. Share one data-collection and aggregation core across both modes.
- R3. Keep the monthly summary compact and conclusion-first.
- R4. Include monthly summary metrics: PR count, CI E2E P50/P90, queue P90, execution P90, and SLA rate.
- R5. Evaluate the monthly report directly against the `<= 60 min` target.
- R6. Include the fixed four-bucket CI E2E distribution in monthly mode.
- R7. Show count and percentage for each monthly bucket, with representative long-tail examples when useful.
- R8. Produce a one-line judgment about the month's CI submission experience.
- R9. In daily mode, surface current problems first rather than repo-level summary first.
- R10. In daily mode, produce an actionable problem list that highlights current slow workflows, jobs, steps, and persistent drag items.
- R11. Detect anomalies from SLA, long-tail share, queue P90, and execution P90.
- R12. Distinguish broad slowness from long-tail behavior and queue bottlenecks from execution bottlenecks.
- R13. Generate a PR-oriented workflow -> job -> step drill-down table.
- R14. Include both duration and run-count signals at every layer.
- R15. Include a longest-job ranking with max, average, total runtime, run count, and outlier-vs-frequent drag interpretation.
- R16. Make the drill-down actionable for prioritizing remediation work and for daily tracking.
- R17. Explicitly mark metrics that are not trustworthy or have no usable sample.
- R18. Keep PR review out of the monthly-summary headline set unless the underlying sample becomes reliable.
- R19. Degrade step analysis to appendix-only when step coverage is incomplete.
- R20. Preserve the distinction between monthly summary output and daily diagnostic output.
- R21. Keep the layered structure even if the artifact remains Excel- or text-based.

## Scope Boundaries

- Do not build a new frontend page or dashboard for this report.
- Do not modify existing frontend behavior under `src/`.
- Do not modify existing ETL behavior under `etl/`.
- Do not turn the first release into a full developer productivity scorecard covering flaky retries, review latency, or first-pass success.
- Do not add cross-repo monthly or daily comparison in this first pass.
- Do not require automated slide generation or presentation formatting beyond report-ready artifacts.

## Context & Research

### Relevant Code and Patterns

- `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py` already handles merged PR discovery, workflow run discovery, job fetches, P90 aggregation, SLA rate calculation, and Excel export.
- The current script only keeps per-run maxima for queue and execution time. It does not persist workflow names, job-level rollups, step-level rollups, or per-layer run counts.
- The GitHub jobs API returns `workflow_name` on each job record and includes `steps` with `name`, `started_at`, and `completed_at`, so the required drill-down data is available from the existing API surface.
- The current output writer produces a single flat sheet named `CI效率报告`; it has no concept of `Management Summary` versus `Diagnostic Appendix`.
- No existing Python test harness is present for this skill. The implementation plan should create a focused test module rather than rely on manual verification alone.

### Institutional Learnings

- None found in `docs/solutions/`.

### External References

- None. Local repo context and direct GitHub API inspection were sufficient for planning this change.

## Key Technical Decisions

- Keep GitHub as the source of truth for the first release rather than introducing a local pre-aggregation cache.
  Rationale: the feature request is about report structure and diagnosis depth, not collector architecture. The current script already fetches the right entities.
- Introduce an internal layered report model before touching Excel output.
  Rationale: the current script mixes fetching, aggregation, and rendering. The report needs durable structures for summary metrics, bucket distributions, workflow/job/step rows, and longest-job rankings.
- Treat monthly and daily reports as separate first-class modes rather than one report with minor filtering.
  Rationale: the audience, question set, and ordering of information are materially different.
- Treat `Management Summary` and `Diagnostic Appendix` as separate output sections within monthly mode even if they land in one workbook.
  Rationale: the audience split inside monthly mode is part of the feature, not a presentation detail.
- Keep PR review metrics out of the summary layer until the sampled data is proven reliable.
  Rationale: current runs showed empty or unreliable review samples. The report should prefer honest omission over misleading precision.
- Represent “heavy but rare” versus “frequent drag” explicitly in the ranking layer.
  Rationale: run count is required to avoid over-prioritizing single pathological runs.

## Open Questions

### Resolved During Planning

- Is the data source sufficient for workflow/job/step drill-down?
  Resolution: Yes. The current GitHub jobs API response already contains `workflow_name` and `steps`, so the missing work is in aggregation and report shaping rather than source availability.
- Should this feature be implemented through a new page or through the skill itself?
  Resolution: Through `.agents/skills/ci-efficiency-report` only, per origin requirements.
- Should monthly and daily reports be treated as separate products?
  Resolution: Yes. They should share data plumbing but have distinct output modes and content priorities.

### Deferred to Implementation

- Whether the final artifact should be one workbook with multiple sheets, two separate workbooks, or a workbook plus companion Markdown/text summary.
- The exact scoring rule for longest-job prioritization when max runtime and run frequency point in different directions.
- Whether monthly analysis should be driven by explicit start/end dates in the script interface or by a month shorthand that resolves to a date window.
- How daily mode should distinguish “new” issues from “ongoing” issues without introducing a larger history store.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
report mode + time window
  -> fetch merged PRs in window
  -> fetch PR details with head_sha
  -> fetch workflow runs for each PR
  -> fetch jobs for each run
  -> extract step timings when present
  -> build normalized structures:
       PR report rows
       workflow aggregates
       job aggregates
       step aggregates
       bucket distribution
       longest-job ranking
       daily problem list
  -> render:
       if monthly:
         1) Management Summary
         2) Diagnostic Appendix
       if daily:
         1) Current Problems
         2) Daily Drill-down
```

## Implementation Units

- [ ] **Unit 1: Introduce normalized report models and aggregation helpers**

**Goal:** Separate raw GitHub fetches from report-level structures so the script can support monthly summaries, daily problem lists, workflow/job/step drill-down, and longest-job ranking without entangling the Excel writer.

**Requirements:** R1, R2, R4, R6, R7, R9, R10, R11, R12, R13, R14, R15, R17, R20, R21

**Dependencies:** None

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Create: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Introduce internal structures for PR-level summaries, workflow aggregate rows, job aggregate rows, step aggregate rows, distribution buckets, daily problem rows, and longest-job ranking rows.
- Centralize duration math so queue, execution, run E2E, and step duration all use the same timestamp-diff rules.
- Add classification helpers for anomaly detection and for interpreting “rare outlier” versus “frequent drag”.
- Keep report models detached from Excel column layout so the writer can evolve without reworking computation code.

**Patterns to follow:**
- Existing `diff_minutes`, `percentile`, and GitHub pagination helpers in `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`

**Test scenarios:**
- Happy path: a synthetic PR with multiple workflows, jobs, and steps produces correctly nested aggregates and bucket placement.
- Edge case: missing `started_at` or `completed_at` on a job or step excludes only the affected metric while preserving run counts where valid.
- Edge case: no reliable PR review samples yields an explicit “not reliable”/empty state rather than a fake numeric value.
- Integration: longest-job interpretation distinguishes a single massive outlier from a frequently slow job, and daily problem ranking can be built from the same aggregates.

**Verification:**
- Aggregation helpers can emit stable summary and appendix models from mocked GitHub payloads without depending on Excel output.

- [ ] **Unit 2: Expand data collection from max-only metrics to workflow/job/step detail**

**Goal:** Capture the detailed GitHub data needed for workflow/job/step drill-down and run-count-aware rankings.

**Requirements:** R13, R14, R15, R16, R19

**Dependencies:** Unit 1

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Test: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Preserve workflow names instead of treating per-PR runs as anonymous positions like `WF1`, `WF2`, etc.
- For each job, record job name, workflow name, queue duration, execution duration, and step rows when present.
- For each step, record step name and duration, while marking incomplete coverage clearly when step timestamps are missing.
- Count occurrences at workflow, job, and step levels so later ranking logic can reason about frequency.

**Patterns to follow:**
- Existing GitHub API fetch flow in `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`

**Test scenarios:**
- Happy path: one workflow with two jobs and multiple timed steps is collected with the correct roll-up counts.
- Happy path: multiple runs of the same workflow and job aggregate under one logical name with incremented run counts.
- Edge case: jobs API returns steps for some jobs but not others; the report marks step analysis as partial.
- Edge case: duplicate job names across workflows do not collide because workflow/job identity is preserved.

**Verification:**
- Raw fetched data is rich enough to produce per-workflow, per-job, and per-step appendix tables with counts.

- [ ] **Unit 3: Add management-summary metrics and anomaly interpretation**

**Goal:** Produce a conclusion-first monthly summary suitable for managers, anchored on the `<= 60 min` target and the fixed CI E2E distribution buckets.

**Requirements:** R3, R4, R5, R6, R7, R8, R11, R12, R17, R18

**Dependencies:** Units 1-2

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Test: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Add CI E2E P50 in addition to the existing P90 summary metrics.
- Build the fixed four-bucket distribution with PR count and percentage.
- Generate a compact anomaly summary that explains whether the month is failing because of broad slowdown, long-tail behavior, queueing, or execution-heavy workflows.
- Keep PR review metrics out of the headline summary when sample reliability is insufficient.

**Patterns to follow:**
- Existing repo-level metric calculations and SLA formatting in `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`

**Test scenarios:**
- Happy path: a balanced month with most PRs under 60 minutes is marked healthy and summarized correctly.
- Happy path: a long-tail-heavy month is classified as long-tail severe even if the median is acceptable.
- Edge case: queue P90 dominates execution P90 and the narrative flags queueing as the primary bottleneck.
- Edge case: review samples missing or zero-length do not appear as a trustworthy headline metric.

**Verification:**
- The summary layer can be rendered without reading appendix-level details and still communicates target adherence and primary bottleneck.

- [ ] **Unit 4: Render `Management Summary` and `Diagnostic Appendix` artifacts**

**Goal:** Reshape monthly report output so the workbook and any optional text summary respect the required audience split inside monthly mode.

**Requirements:** R1, R2, R20, R21

**Dependencies:** Units 1-3

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Test: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Replace the single flat output sheet with separate sections or separate sheets for management summary and diagnostic appendix.
- Ensure the summary sheet leads with key metrics, bucket distribution, anomaly interpretation, and top workflow/job priorities.
- Ensure the appendix contains workflow/job/step tables plus longest-job ranking and coverage/truthfulness notes.
- Keep formatting pragmatic: readable headers, frozen panes, and minimal color coding only where it clarifies target status.

**Patterns to follow:**
- Existing Excel styling helpers in `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`

**Test scenarios:**
- Happy path: workbook contains both `Management Summary` and `Diagnostic Appendix` sections/sheets with the expected columns.
- Edge case: partial step coverage is surfaced as a note in the appendix instead of silently omitted.
- Edge case: a repository with no qualifying PRs still renders a truthful empty report rather than crashing.

**Verification:**
- The final artifact is usable directly in a monthly management report without manual reorganization.

- [ ] **Unit 5: Add daily diagnostic mode and problem-list rendering**

**Goal:** Produce a technical-team-focused daily report that highlights current problems, their likely hotspots, and what should be tracked next.

**Requirements:** R1, R2, R9, R10, R15, R16, R20, R21

**Dependencies:** Units 1-4

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Modify: `.agents/skills/ci-efficiency-report/SKILL.md`
- Test: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Add an explicit report-mode switch such as `monthly_summary` vs `daily_diagnostic`.
- Define a daily problem-row model that ranks current hotspots using runtime, run count, and anomaly severity.
- Render a daily-first artifact that starts with current problems, then supports workflow/job/step drill-down for those problems.
- Surface “new vs ongoing” as a soft classification only when enough prior-window context exists; otherwise mark it as “current issue” rather than inventing persistence.

**Patterns to follow:**
- The same normalized aggregate structures introduced in Units 1-2

**Test scenarios:**
- Happy path: daily mode renders a ranked current-problems section before any broad summary.
- Happy path: the same slow job appears in both longest-job ranking and the daily problem list with consistent metrics.
- Edge case: when prior-window comparison is unavailable, the report does not mislabel issues as new or ongoing.
- Edge case: daily mode with no severe issues still renders a truthful “no major issues detected” summary.

**Verification:**
- Technical users can open the daily artifact and immediately see what needs attention today.

- [ ] **Unit 6: Add CLI/report-window ergonomics for monthly and daily reporting**

**Goal:** Make month-scoped and day-scoped reporting practical and repeatable without forcing manual reinterpretation of a generic `--days` window.

**Requirements:** R1, R5, R9, R20

**Dependencies:** Units 1-4

**Files:**
- Modify: `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Modify: `.agents/skills/ci-efficiency-report/SKILL.md`
- Test: `.agents/skills/ci-efficiency-report/tests/test_ci_efficiency_report.py`

**Approach:**
- Add a precise date-window mode for single-repo monthly analysis, either as explicit `start/end` inputs or a month-resolving convenience flag.
- Add an explicit report-mode input so callers can request monthly vs daily output intentionally.
- Ensure the report prints the resolved date window in the artifact so monthly and daily conclusions are auditable.
- Update the skill instructions to describe both report modes and their different output shapes.

**Patterns to follow:**
- Existing CLI argument handling in `.agents/skills/ci-efficiency-report/scripts/ci_efficiency_report.py`
- Current skill documentation style in `.agents/skills/ci-efficiency-report/SKILL.md`

**Test scenarios:**
- Happy path: explicit date-window input limits PR search and report labels to the requested month or day.
- Edge case: invalid or reversed date windows fail with a clear error instead of producing a misleading report.
- Integration: report-mode selection and scoped reporting still support the shared aggregate logic and the different monthly/daily output layers.

**Verification:**
- Operators can request “April monthly report for repo X” or “today's technical diagnostic for repo X” without translating that into an imprecise rolling-day window.

## System-Wide Impact

- **Interaction graph:** The skill evolves from repo-level stat aggregation to a layered report pipeline: mode + window -> PR search -> workflow runs -> jobs -> steps -> monthly summary or daily problem renderers.
- **Data trust:** The report must track both metric values and metric reliability, especially for review and step-level coverage.
- **Performance and rate limits:** Fetch volume will increase because step-level detail and richer aggregation require preserving more job payloads. The implementation should avoid unnecessary duplicate calls and keep pagination behavior predictable.
- **Artifact shape:** Existing users of the script may rely on a single-sheet workbook; the change should either preserve backward-compatible top-level values or clearly document the new monthly/daily layout.
- **Testing surface:** Python tests become necessary because regression risk is now in aggregation logic, not just manual inspection of one output sheet.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Step-level data is present for some jobs but not all | Treat step analysis as appendix-only and explicitly mark partial coverage |
| Additional aggregation makes the script slower on large repos | Keep fetch reuse tight, support bounded date windows, and avoid recomputing derived values multiple times |
| Longest-job ranking becomes noisy if based on one extreme run | Include max, average, total runtime, and run count together so interpretation is not one-dimensional |
| Workbook restructuring surprises existing users | Keep main repo-level metrics visible in the summary layer and update skill docs with the new artifact shape |
| Review-time metrics remain unreliable | Keep them out of the management-summary headline set until the sampling issue is resolved |

## Documentation / Operational Notes

- Update `.agents/skills/ci-efficiency-report/SKILL.md` together with the script so the documented output contract matches reality.
- The first release should document clearly that both monthly and daily reports are optimized for single-repo analysis.
- If the final artifact remains Excel-first, include the resolved date window, repo name, and report mode prominently in the report header.
- Keep implementation changes scoped to `.agents/skills/ci-efficiency-report/` and report docs; frontend and ETL code are explicitly out of scope.
