# ADR-005: Workflow File and Attempt Scoped Collection

**Status**: Accepted  
**Date**: 2026-07-02  
**Context**: Tracked workflow collection redesign

## Decision

Tracked workflow analysis is scoped by workflow file basename and optional workflow ref, not by workflow name. Repository configuration may use rules such as `file: ci.yml` and optionally `ref: main` or `ref: release/*`; full workflow paths and workflow names are not match keys. Configuration validation may call GitHub workflows APIs to verify workflow files, but daily collection uses workflow run metadata and does not add workflow metadata calls for matching.

Workflow execution is stored at attempt granularity. Stable run metadata remains keyed by `run_id`, while execution attempts are represented by separate workflow attempt records keyed by `run_id + run_attempt`. Jobs and steps are tied to those attempts using `run_id + run_attempt + job_id` and `run_id + run_attempt + job_id + step_number`. PR workflow links point to workflow attempts rather than run-level metadata, so reruns remain visible in PR counts, timing, and conclusion breakdowns.

Steps are persisted only when they are eligible for step runtime analysis: the tracked workflow attempt succeeded and its workflow total duration exceeds the configured threshold. Thresholds default to 600 seconds and can be overridden by exact-ref workflow, glob-ref workflow, file-only workflow, repository, then defaults. If a configuration change makes historical attempts newly tracked, workflow details backfill collects jobs and eligible steps within the retention window. If a policy change makes historical attempts step-eligible, step eligibility backfill runs automatically within the retention window and a per-run API budget, defaulting to 100 attempts per collection run.

## Rationale

Workflow names can be duplicated or renamed without changing the workflow file, so they are not stable enough for tracked workflow identity. Workflow file basename plus ref gives a clearer analysis key while avoiding full-path configuration and daily workflow metadata API calls.

GitHub reruns make `run_id` alone insufficient for execution metrics. Treating each `run_attempt` as its own workflow attempt preserves CI cost, waiting time, success/failure counts, and per-attempt drill-downs. Keeping run metadata separate avoids a disruptive composite primary key change on the existing `runs` table.

The jobs API may include steps even when we only need job statistics. Persisting only eligible step data keeps storage and analysis focused, while bounded automatic backfill lets workflow configuration and threshold changes converge without causing an unbounded API spike.

## Consequences

### Positive
- PR metrics can show every workflow attempt, including reruns.
- Workflow and job statistics are scoped to configured workflow files and refs.
- Step analysis remains focused on slow successful workflows.
- Configuration mistakes are caught in CI without adding metadata API calls to daily collection.

### Negative
- Existing schema needs migration for workflow files, refs, workflow attempts, and attempt-scoped job/step identities.
- Historical data needs workflow file backfill from stored run payloads before tracked statistics are rebuilt.
- Threshold changes can trigger additional jobs API calls for step eligibility backfill, though bounded by budget.

## Alternatives Considered

1. **Match by workflow name** — rejected because names can be duplicated or renamed and do not safely identify workflow files.
2. **Use `run_id` as the workflow execution identity** — rejected because reruns would overwrite or collapse separate attempts.
3. **Persist all steps from every jobs response** — rejected because it grows storage and includes data outside the step runtime analysis scope.
4. **Manual-only step backfill after policy changes** — rejected because eligible historical analysis should converge automatically within a bounded budget.
