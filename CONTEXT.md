# Action Insight

Action Insight collects and analyzes GitHub Actions execution data for selected open-source repositories.

## Language

**Tracked Repository**:
A GitHub repository configured for collection and analysis.
_Avoid_: target repo, configured repo

**Tracked Workflow**:
A workflow whose run, job, and eligible step data is included in detailed analysis by configuration.
_Avoid_: all workflow, selected workflow

**Collection Window**:
A bounded created-time range for one Tracked Repository's raw workflow-run collection and durable checkpoint.
_Avoid_: batch, chunk

**GitHub Identity Lane**:
The serial collection lane for credentials sharing one authenticated GitHub identity.
_Avoid_: token lane

**API Budget Reserve**:
The core-rate-limit requests that a GitHub Identity Lane deliberately leaves unspent while dispatching collection work.
_Avoid_: spare tokens

**Collection Heartbeat**:
The periodic console-only status line for shared Collection Window dispatch, reporting completed, failed, pending, and active work.
_Avoid_: telemetry, progress record

**Collection Summary**:
The console-only terminal count of completed, failed, deferred, and retried operations for one shared collection plan.
_Avoid_: collection checkpoint, success report

**Workflow Match Rule**:
A configuration rule that matches a GitHub Actions workflow by workflow file basename and, when configured, workflow ref.
_Avoid_: workflow filter

**Workflow File Path**:
The GitHub workflow run `path` value that identifies the workflow file and ref, such as `.github/workflows/ci.yml@main`.
_Avoid_: workflow path

**Workflow Ref Unavailable**:
A workflow run whose metadata includes a workflow file but not a usable workflow ref.
_Avoid_: missing workflow ref

**Workflow File Unavailable**:
A workflow run whose metadata does not include a usable **Workflow File Path**.
_Avoid_: missing workflow path

**Workflow File Backfill**:
The migration that derives structured workflow file basenames from stored run payloads for historical data.
_Avoid_: workflow path migration

**Missing Tracked Workflow**:
A configured workflow match rule that does not match any collected workflow run for its repository.
_Avoid_: empty workflow

**Repository Configuration Validation**:
The CI check that verifies tracked repositories and workflow match rules before collection changes are accepted.
_Avoid_: config lint

**Workflow Run Metadata**:
The run-level GitHub Actions data needed to associate CI executions with PRs and compute PR-level timing and outcome metrics.
_Avoid_: workflow data

**Workflow Details**:
The job and eligible step data collected only for **Tracked Workflows**.
_Avoid_: workflow data, full workflow data

**Workflow Runtime**:
The elapsed time from when a workflow run starts executing to when it finishes.
_Avoid_: workflow duration, run age

**Workflow Queue Duration**:
The elapsed time from when a workflow run is created to when it starts executing.
_Avoid_: queue time

**Workflow Total Duration**:
The elapsed time from when a workflow run is created to when it finishes.
_Avoid_: workflow runtime

**Workflow Completion Time**:
The best available finish time for a workflow attempt.
_Avoid_: updated time

**Slow Successful Workflow**:
A successful **Tracked Workflow** run whose **Workflow Total Duration** exceeds the configured step-analysis threshold.
_Avoid_: slow workflow

**Step Analysis Threshold**:
The configurable **Workflow Total Duration** threshold that determines whether a successful tracked workflow run contributes step data.
_Avoid_: step threshold

**Step Runtime Analysis**:
The optimization analysis based on step data from **Slow Successful Workflows**.
_Avoid_: workflow optimization analysis

**Eligible Step Data**:
Step data from a **Slow Successful Workflow** that is persisted and used for analysis.
_Avoid_: collected steps

**Step Eligibility Backfill**:
Automatic collection of step data for historical workflow attempts that become eligible after a step-analysis policy change.
_Avoid_: manual step backfill

**Workflow Details Backfill**:
Automatic collection of jobs and eligible steps for historical workflow attempts that become tracked after configuration changes.
_Avoid_: manual workflow backfill

**Tracked PR CI**:
The subset of a pull request's CI executions that match configured **Tracked Workflows**.
_Avoid_: PR CI, full PR CI

**PR Current CI Success**:
Whether every tracked workflow file and ref has a latest terminal attempt with a successful conclusion for a pull request.
_Avoid_: PR success rate

**PR Attempt Success Rate**:
The success rate across all terminal tracked workflow attempts for a pull request.
_Avoid_: PR current success

**PRs Without Tracked CI**:
Pull requests that have no tracked workflow attempts.
_Avoid_: missing PR CI

**Workflow Attempt**:
One execution of a **Tracked Workflow** for a pull request.
_Avoid_: workflow run when discussing PR-level counts

**Workflow Attempt Identity**:
The unique identity of a workflow attempt, composed of GitHub `run_id` and `run_attempt`.
_Avoid_: workflow run id

**Workflow Attempt Record**:
The stored execution record for one **Workflow Attempt**.
_Avoid_: run row

**Terminal Workflow Attempt**:
A workflow attempt whose GitHub status is completed and whose conclusion is available.
_Avoid_: completed workflow

**Total Workflow Time**:
The sum of **Workflow Total Duration** across all **Workflow Attempts** in **Tracked PR CI**.
_Avoid_: total CI compute time

**PR CI Wall Time**:
The elapsed time from the first **Workflow Attempt** being created to the last **Workflow Attempt** finishing in **Tracked PR CI**.
_Avoid_: PR CI duration

**Total Runtime**:
The sum of **Workflow Runtime** across terminal tracked workflow attempts.
_Avoid_: total compute time

**Total Queue Duration**:
The sum of **Workflow Queue Duration** across terminal tracked workflow attempts.
_Avoid_: total queue time

**Current CI Elapsed Time**:
The live elapsed time for a pull request with non-terminal tracked workflow attempts.
_Avoid_: PR CI wall time

**Current Runtime**:
The live runtime accumulated by non-terminal tracked workflow attempts that have started.
_Avoid_: current CI compute time

**Tracked Job**:
A GitHub Actions job that belongs to a **Tracked Workflow**.
_Avoid_: all job, workflow job

**Job Queue Duration**:
The elapsed time from when a job is created to when it starts executing.
_Avoid_: job queue time

**Job Runtime**:
The elapsed time from when a job starts executing to when it finishes.
_Avoid_: job duration

**Job Total Duration**:
The elapsed time from when a job is created to when it finishes.
_Avoid_: job runtime

**Resource Model**:
The normalized runner accelerator model attributed to a job from its runner labels, such as `npu-a3`.
_Avoid_: runner type, resource type

**Resource Count**:
The positive number of accelerator resources attributed to a job from its runner labels.
_Avoid_: card count, runner count

**Static Resource Requirement**:
The maximum accelerator-card topology declared in a tracked workflow's YAML and recorded in analysis configuration. It takes precedence over runner-label inference for report resource requirements.
_Avoid_: inferred card count

**Machine-Hours**:
The attributed runner occupancy of a job, computed as **Job Runtime** multiplied by **Resource Count** and converted to hours. It is not device utilization or monetary cost.
_Avoid_: cost, compute time, NPU hours

**Unknown-Cost Sample**:
A job whose **Machine-Hours** cannot be computed because **Job Runtime** or a positive **Resource Count** is unavailable.
_Avoid_: zero-cost job

**Forced Merge Indicator**:
Whether a pull request was merged before its tracked CI completed.
_Avoid_: failed merge, forced push

**Invalid Timing Sample**:
A workflow, job, or step sample whose required timestamps are missing, malformed, or produce a negative duration.
_Avoid_: bad duration

**Job Attempt Identity**:
The unique identity of a job execution, composed of GitHub `run_id`, `run_attempt`, and `job_id`.
_Avoid_: job id

**Step Attempt Identity**:
The unique identity of a step execution, composed of GitHub `run_id`, `run_attempt`, `job_id`, and step number.
_Avoid_: step id

**Step Runtime**:
The elapsed time from when a step starts executing to when it finishes.
_Avoid_: step duration

**Cluster View**:
A statistics view that groups repeated executions by job or step name.
_Avoid_: table view

**Timeline View**:
A paginated view that lists PRs or workflow attempts in occurrence order.
_Avoid_: chronological table

**Workflow Success Rate**:
The percentage of successful terminal workflow attempts among tracked workflow attempts.
_Avoid_: workflow pass rate

**Job Success Rate**:
The percentage of successful terminal jobs among tracked jobs.
_Avoid_: job pass rate

**Step Success Rate**:
The percentage of successful terminal steps among eligible step samples.
_Avoid_: step pass rate

**Successful Duration Percentile**:
A P50 or P90 duration metric computed only from successful tracked attempts or jobs.
_Avoid_: duration percentile

**Non-Success Analysis**:
The separate analysis of failed, cancelled, timed-out, skipped, neutral, and action-required outcomes outside successful duration percentiles.
_Avoid_: failure analysis

## Relationships

- A **Tracked Repository** has zero or more **Tracked Workflows**
- Each **Collection Window** belongs to one **Tracked Repository** and is dispatched by at most one **GitHub Identity Lane** at a time
- A **GitHub Identity Lane** completes recent **Collection Windows** across Tracked Repositories before it dispatches history backfill, while preserving its **API Budget Reserve**
- A **Workflow Match Rule** selects zero or more **Tracked Workflows**
- **Workflow Match Rules** support workflow file basenames such as `ci.yml` and may scope matches by workflow ref
- Workflow names and full workflow paths are not supported in **Workflow Match Rules**
- A workflow run belongs to at most one **Tracked Workflow**, using workflow file basename and workflow ref matching
- A **Workflow Match Rule** without a ref matches all workflow refs
- Workflow ref matching supports exact refs and glob patterns such as `release/*`; regex is not supported
- When multiple rules can match the same run, precedence is exact ref, then glob ref, then file-only
- Multiple same-precedence rules matching the same run are invalid configuration
- **Workflow File Path** is parsed from workflow run metadata without guessing from workflow name
- Workflow file basename is parsed from the path segment before `@`; workflow ref is parsed from the segment after `@`
- **Workflow Ref Unavailable** runs can match file-only rules but cannot match ref-specific rules, and are grouped under an explicit unknown ref bucket
- Run storage keeps structured `workflow_file`, optional `workflow_ref`, and optional raw `workflow_path` fields
- Tracked workflow statistics are grouped by both `workflow_file` and `workflow_ref`
- **Workflow File Unavailable** runs keep **Workflow Run Metadata** but do not become **Tracked Workflows** and do not trigger job collection
- **Workflow File Backfill** should populate historical workflow file basenames from stored run payloads before rebuilding tracked statistics
- Historical jobs and steps that do not match current **Workflow Match Rules** are retained but excluded from tracked statistics
- A **Tracked Repository** without any **Workflow Match Rules** is not included in statistics
- A **Missing Tracked Workflow** creates a visible warning but does not stop collection for other repositories
- **Repository Configuration Validation** must fail invalid repository entries, missing workflow rules, non-file workflow rules, duplicate rules, and GitHub workflow files that cannot be found during online CI validation
- **Repository Configuration Validation** may call GitHub workflows APIs to validate workflow file existence, but daily collection does not call those APIs for matching
- **Repository Configuration Validation** validates workflow ref syntax and overlapping rule precedence, but it does not require refs to exist before matching historical or future runs
- All workflows selected by **Workflow Match Rules** are included in workflow and job statistics regardless of whether they are triggered by pull requests, schedules, manual dispatch, or other events
- A **Tracked Workflow** produces zero or more **Tracked Jobs**
- **Workflow Run Metadata** is collected for all workflows in a **Tracked Repository**
- **Workflow Run Metadata** retains GitHub event metadata for PR association and diagnostics
- PR association resolution only targets PR-like and push events to avoid wasting API calls on events that cannot map to PRs
- **Workflow Details** are collected only for **Tracked Workflows**
- **Workflow Runtime** excludes time before the workflow run starts executing
- **Workflow Total Duration** includes both **Workflow Queue Duration** and **Workflow Runtime**
- **Workflow Queue Duration** is computed from workflow `created_at` to `run_started_at`
- **Workflow Runtime** is computed from `run_started_at` to **Workflow Completion Time**
- **Workflow Completion Time** uses explicit completion time when available, otherwise completed workflow attempts may use `updated_at` as the finish-time proxy
- UI metrics must explain that **Workflow Total Duration** equals **Workflow Queue Duration** plus **Workflow Runtime**
- **Job Total Duration** includes both **Job Queue Duration** and **Job Runtime**
- **Job Queue Duration** is computed from job `created_at` to job `started_at`
- **Job Runtime** is computed from job `started_at` to job `completed_at`
- UI metrics must explain that **Job Total Duration** equals **Job Queue Duration** plus **Job Runtime**
- **Machine-Hours** equal **Job Runtime** × **Resource Count** ÷ 3600 and exclude **Job Queue Duration**
- **Static Resource Requirement** is the primary source for workflow-level report card requirements; runner labels are fallback-only
- Jobs without a valid **Job Runtime** and positive **Resource Count** are **Unknown-Cost Samples**, excluded from Machine-Hour totals, and counted separately
- Missing **Resource Model** values are grouped under an explicit unknown bucket rather than guessed from job or workflow names
- **Forced Merge Indicator** requires both merge and tracked-CI completion timestamps; pull requests with partial CI history are excluded from its rate denominator
- **Invalid Timing Samples** are excluded from duration averages and percentiles, counted separately, and surfaced as data quality warnings
- **Step Runtime Analysis** includes only **Slow Successful Workflows**
- Step-level duration analysis uses **Step Runtime** only; steps do not have queue or total duration metrics
- Only **Eligible Step Data** is persisted and used, even when the jobs API response includes steps for non-eligible workflow attempts
- **Workflow Details Backfill** fills jobs and eligible steps for newly tracked historical workflow attempts within the retention window
- **Step Eligibility Backfill** fills historical eligible steps after threshold or workflow policy changes
- **Step Eligibility Backfill** is limited to the current retention window and bounded by a per-run API budget
- **Step Eligibility Backfill** defaults to 100 attempts per collection run and can be overridden by environment configuration
- **Workflow Details Backfill** uses the same per-run API budget controls as **Step Eligibility Backfill**
- Pending **Workflow Details Backfill** and **Step Eligibility Backfill** counts must be visible in logs or UI
- **Step Analysis Threshold** defaults to 600 seconds and override precedence is exact-ref workflow, glob-ref workflow, file-only workflow, repository, then defaults
- **Tracked PR CI** includes only workflow runs from **Tracked Workflows**, even when a pull request triggers other workflows
- **Tracked PR CI** preserves every **Workflow Attempt** instead of collapsing to the latest attempt
- **PR Current CI Success** uses the latest terminal attempt per tracked workflow file and ref that actually appears on the pull request
- Configured workflows that do not appear on a pull request do not make **PR Current CI Success** incomplete
- A pull request with no tracked workflow attempts has no tracked CI rather than an incomplete current CI state
- Repository-level PR CI metrics include only pull requests with tracked workflow attempts
- **PRs Without Tracked CI** are counted separately to show tracked workflow coverage
- **PR Attempt Success Rate** uses all terminal tracked workflow attempts and the same terminal-outcome denominator semantics as **Workflow Success Rate**
- GitHub reruns are separate **Workflow Attempts** and use **Workflow Attempt Identity** to avoid overwriting earlier attempts
- Non-terminal workflow attempts are retained for visibility but excluded from success rates, duration percentiles, PR total time, and step eligibility
- Formal workflow, job, PR timing, and step-analysis metrics use **Terminal Workflow Attempts**
- Run-level storage keeps stable GitHub run metadata keyed by `run_id`
- **Workflow Attempt Records** are stored separately from run metadata and keyed by `run_id + run_attempt`
- **Workflow Attempt Records** track jobs fetch time, step eligibility check time, step collection time, and step policy hash
- Step policy hash includes the matched workflow file, matched workflow ref rule, step threshold, and step eligibility policy version
- Full raw jobs payloads are not retained solely for future step policy changes
- Pull request association belongs to run-level metadata and **Workflow Attempt Records** inherit it through `run_id`
- Pull request workflow links point to **Workflow Attempt Records**, not run-level metadata
- Jobs and steps belong to **Workflow Attempt Records**, not just run metadata
- Tracked job storage uses **Job Attempt Identity** so rerun jobs remain tied to the correct workflow attempt
- Step storage uses **Step Attempt Identity** so rerun steps remain tied to the correct job attempt
- PR workflow views default to `workflow_file + workflow_ref` groups and may provide clearly labeled cross-ref summaries by `workflow_file`
- The UI navigation exposes PR, workflow, job, and step views; it does not expose a separate event view
- Repository-level workflow and job statistics include all trigger sources for tracked workflows by default
- PR views include only tracked workflow attempts associated with pull requests
- Workflow, job, and step views use repository-level tracked workflow data
- PR and workflow views are **Timeline Views** ordered by occurrence time and paginated
- PR **Timeline View** rows represent pull requests and expand to show their tracked workflow attempts
- PR **Timeline View** hides pull requests without tracked CI by default, shows a **PRs Without Tracked CI** count, and provides a toggle to include them
- Workflow **Timeline View** rows represent individual **Workflow Attempt Records**
- Workflow **Timeline View** shows non-terminal attempts for visibility while clearly excluding them from formal metrics
- Workflow **Timeline View** includes non-terminal attempts by default and provides a status filter
- PR **Timeline View** defaults to latest tracked workflow attempt completion or update time descending, with PR creation time as fallback
- Workflow **Timeline View** defaults to workflow attempt creation time descending
- Timeline Views support sorting by created time, completed time, and total duration
- PR **Timeline View** defaults to 50 rows per page
- Workflow **Timeline View** defaults to 100 rows per page
- Cluster Views default to 100 rows per page
- Paginated views should support 25, 50, 100, and 200 row page sizes
- Views default to a 30-day time range and support 7, 14, 30, 60, and 90 days, capped by the retention window
- Cluster View percentile rows with fewer than 5 successful samples are marked as low sample
- Cluster Views provide a minimum successful sample filter that defaults to 5 and can be disabled
- Cluster View minimum sample filtering uses successful sample count, not terminal execution count
- Job **Cluster View** defaults to grouping by workflow file, workflow ref, and job name, with a clearly labeled cross-workflow job-name summary
- Step **Cluster View** defaults to grouping by workflow file, workflow ref, job name, and step name, with a clearly labeled cross-job and cross-workflow step-name summary
- Job and step **Cluster Views** show success rate, execution count, average duration, P50, and P90
- Job and step **Cluster Views** aggregate terminal workflow attempts only
- Job **Cluster View** must show a coverage note explaining that jobs cover terminal tracked workflow attempts and are not limited by the step-analysis threshold
- Step **Cluster View** must show a coverage note explaining that steps are collected only for successful tracked workflows whose total duration exceeds the configured threshold
- Step **Cluster View** must show the active step threshold and eligible workflow attempt count
- Cluster View average duration uses successful samples only, matching P50/P90 duration semantics
- Cluster View average duration uses arithmetic mean; trimmed mean is not used
- Cluster View execution count uses all terminal samples and should be paired with successful sample count
- Cluster Views show non-success counts and proportions separately from duration metrics
- Job and step **Cluster Views** support finding flaky jobs, slow jobs, and slow steps
- Job **Cluster View** defaults to sorting by P90 **Job Total Duration** descending
- Step **Cluster View** defaults to sorting by P90 **Step Runtime** descending
- Cluster Views support sorting by success rate, execution count, average duration, P50, P90, and non-success rate
- **Total Workflow Time** and **PR CI Wall Time** include all terminal tracked workflow attempts regardless of conclusion
- **PR CI Wall Time** includes only terminal tracked workflow attempts; live non-terminal timing is shown as **Current CI Elapsed Time**
- Live non-terminal execution is shown as **Current Runtime**, separate from **Total Runtime**
- **Total Workflow Time** must be shown with **Total Runtime**, **Total Queue Duration**, and their percentages of total workflow time
- **Total Workflow Time** and **PR CI Wall Time** must be shown as separate PR metrics with visible UI definitions, calculation logic, and conclusion breakdown
- **Workflow Success Rate** includes `success`, `failure`, `cancelled`, `timed_out`, and `action_required` attempts in the denominator, while `skipped` and `neutral` are shown separately
- **Job Success Rate** uses the same denominator semantics as **Workflow Success Rate**
- **Step Success Rate** uses the same denominator semantics as **Workflow Success Rate**, with `skipped` and `neutral` shown separately
- Default workflow, job, and step P50/P90 metrics are **Successful Duration Percentiles**
- **Successful Duration Percentiles** use the nearest-rank method and must be explained in metric definitions
- Workflow percentile metrics include total duration, queue duration, and runtime percentiles from successful tracked workflow attempts, with total duration as the primary metric
- Job percentile metrics include total duration, queue duration, and runtime percentiles, with total duration as the primary metric
- Default job P50/P90 metrics include only successful jobs from successful tracked workflow attempts
- Default step P50/P90 metrics include only successful steps from successful tracked workflow attempts
- Failed, cancelled, and timed-out durations are analyzed separately from successful P50/P90 metrics
- **Non-Success Analysis** is required at workflow and job levels, and only best-effort at step level when eligible step data exists
- Step-level **Non-Success Analysis** must not be presented as complete failure root-cause coverage
- UI metrics must explain the **Workflow Success Rate** denominator
- UI metrics must explain the **Job Success Rate** denominator
- UI duration percentile metrics must be labeled as successful-only

## Example Dialogue

> **Dev:** "Do job p50 and p90 cover every job in the repository?"
> **Domain expert:** "No. Job statistics only cover **Tracked Jobs** from configured **Tracked Workflows**."
>
> **Dev:** "Can workflow configuration use workflow names like `CI`?"
> **Domain expert:** "No. **Workflow Match Rules** support workflow file basenames and optional workflow refs."
>
> **Dev:** "If config only says `file: ci.yml`, does it match just `main`?"
> **Domain expert:** "No. It matches all refs, while statistics remain grouped by the actual workflow ref."
>
> **Dev:** "Can workflow ref config use regular expressions?"
> **Domain expert:** "No. Use exact refs or simple glob patterns such as `release/*`."
>
> **Dev:** "If `file: ci.yml` and `file: ci.yml, ref: main` both match a run, do we count it twice?"
> **Domain expert:** "No. The exact-ref rule wins; same-precedence overlap is invalid configuration."
>
> **Dev:** "If a workflow run has no usable `path`, do we infer the file from the workflow name?"
> **Domain expert:** "No. Keep the run metadata, skip detailed collection, and surface a **Workflow File Unavailable** warning."
>
> **Dev:** "Do we delete old jobs and steps collected before tracked workflow filtering?"
> **Domain expert:** "No. Retain them, but exclude details that do not match current **Workflow Match Rules** from tracked statistics."
>
> **Dev:** "If a PR triggers five workflows and only two are configured, do PR metrics show all five?"
> **Domain expert:** "No. PR metrics show only the configured workflows as **Tracked PR CI**."
>
> **Dev:** "Do we call the jobs API for every workflow run?"
> **Domain expert:** "No. We collect **Workflow Run Metadata** for every workflow run, but **Workflow Details** only for **Tracked Workflows**."
>
> **Dev:** "Do untracked workflows keep only a run ID?"
> **Domain expert:** "No. Untracked workflows keep complete run-level metadata, but have no **Workflow Details**."
>
> **Dev:** "Does workflow runtime include time before GitHub starts executing the workflow?"
> **Domain expert:** "No. **Workflow Runtime** starts when the workflow run starts executing and ends when the workflow run finishes."
>
> **Dev:** "Should slow-workflow step analysis include workflows that are slow because they queued for a long time?"
> **Domain expert:** "Yes. The eligibility threshold uses **Workflow Total Duration**, but the report must separate queue delay from runtime work."
>
> **Dev:** "Does job total duration follow the same queue plus runtime model?"
> **Domain expert:** "Yes. **Job Total Duration** equals **Job Queue Duration** plus **Job Runtime**."
>
> **Dev:** "Do failed workflows contribute step data to optimization analysis?"
> **Domain expert:** "No. **Step Runtime Analysis** uses only **Slow Successful Workflows**."
>
> **Dev:** "If the jobs API returns steps for a fast or failed workflow, do we store them?"
> **Domain expert:** "No. Only **Eligible Step Data** is persisted and used."
>
> **Dev:** "Do steps have queue or total duration metrics?"
> **Domain expert:** "No. Step analysis uses **Step Runtime** only."
>
> **Dev:** "If a threshold change makes older workflow attempts step-eligible, do we leave them missing?"
> **Domain expert:** "No. **Step Eligibility Backfill** should collect those historical steps automatically."
>
> **Dev:** "Does automatic step backfill fetch every historical eligible attempt in one run?"
> **Domain expert:** "No. It is limited to the retention window, bounded by per-run API budget, and exposes pending backfill counts."
>
> **Dev:** "If a PR triggers the same tracked workflow three times, do we show only the latest run?"
> **Domain expert:** "No. Show total workflow time, attempt count, success count, failure count, and per-attempt timing analysis."
>
> **Dev:** "Does PR success mean every historical attempt succeeded?"
> **Domain expert:** "No. **PR Current CI Success** uses the latest terminal attempt per tracked workflow file and ref; **PR Attempt Success Rate** summarizes all attempts."
>
> **Dev:** "If a configured workflow never ran for a PR, is the PR CI incomplete?"
> **Domain expert:** "No. PR current success only evaluates tracked workflows that actually appear on that PR."
>
> **Dev:** "Do PRs with no tracked CI count against repository PR success rate?"
> **Domain expert:** "No. They are excluded from PR CI metrics and counted separately as **PRs Without Tracked CI**."
>
> **Dev:** "If GitHub reruns the same workflow run, does it replace the earlier attempt?"
> **Domain expert:** "No. Each `run_attempt` is a separate **Workflow Attempt**."
>
> **Dev:** "Do queued or in-progress workflow attempts affect success rates or duration metrics?"
> **Domain expert:** "No. They are retained for visibility, but formal metrics use **Terminal Workflow Attempts**."
>
> **Dev:** "Should rerun attempts be stored by changing the runs table primary key?"
> **Domain expert:** "No. Keep run metadata stable by `run_id` and store execution attempts in separate **Workflow Attempt Records**."
>
> **Dev:** "If steps were discarded before a threshold change, can backfill recover them without another jobs API call?"
> **Domain expert:** "No, unless raw job payloads were retained. Attempt-level fetch and policy state determines whether to re-fetch."
>
> **Dev:** "Should we store every raw jobs payload just in case step thresholds change later?"
> **Domain expert:** "No. Do budgeted jobs API backfill instead of growing long-term storage."
>
> **Dev:** "Does every rerun attempt need its own PR resolution?"
> **Domain expert:** "No. PR association belongs to the run metadata and attempts inherit it through `run_id`."
>
> **Dev:** "Should PR workflow links point to the run or each attempt?"
> **Domain expert:** "Each attempt. Otherwise reruns are collapsed and PR execution counts become wrong."
>
> **Dev:** "Is GitHub `job_id` alone the job identity?"
> **Domain expert:** "No. Job execution identity includes `run_id`, `run_attempt`, and `job_id`."
>
> **Dev:** "Can steps still be keyed only by `job_id` and step number?"
> **Domain expert:** "No. Step execution identity includes `run_id`, `run_attempt`, `job_id`, and step number."
>
> **Dev:** "Why does total CI time exceed the time a developer waited?"
> **Domain expert:** "Because **Total Workflow Time** sums all workflow attempts, while **PR CI Wall Time** measures the elapsed span."
>
> **Dev:** "Should queue/runtime breakdown show only raw time?"
> **Domain expert:** "No. Show raw time and percentage of **Total Workflow Time** so users can tell whether the bottleneck is queueing or execution."
>
> **Dev:** "Do failed workflow attempts disappear from PR total time?"
> **Domain expert:** "No. PR total time metrics include all terminal tracked attempts and show the conclusion breakdown."
>
> **Dev:** "If a PR still has running CI, does that change PR CI Wall Time every second?"
> **Domain expert:** "No. Running CI is shown as **Current CI Elapsed Time**; **PR CI Wall Time** is based on terminal attempts."
>
> **Dev:** "Does running CI change Total Runtime every second?"
> **Domain expert:** "No. Running execution is shown as **Current Runtime**, separate from terminal **Total Runtime**."
>
> **Dev:** "Can the PR page merge all refs for the same workflow file?"
> **Domain expert:** "Yes, as a clearly labeled cross-ref summary; the default view remains grouped by workflow file and ref."
>
> **Dev:** "Does workflow success rate divide success by every run?"
> **Domain expert:** "No. The denominator is terminal attempts excluding skipped and neutral runs, and the UI must explain that."
>
> **Dev:** "Does job success rate use a different denominator from workflow success rate?"
> **Domain expert:** "No. **Job Success Rate** uses the same terminal-outcome denominator semantics."
>
> **Dev:** "Do failed or cancelled runs affect workflow P90 duration?"
> **Domain expert:** "No. Default P50/P90 duration metrics are **Successful Duration Percentiles**; non-success durations are analyzed separately."
>
> **Dev:** "Are job and step P50/P90 also successful-only?"
> **Domain expert:** "Yes. Default workflow, job, and step percentiles use successful samples only."
>
> **Dev:** "Can skipped or failed steps inside a successful workflow affect step P90?"
> **Domain expert:** "No. Default step percentiles include only successful steps from successful tracked workflow attempts."
>
> **Dev:** "Can a successful job inside a failed workflow affect default job P90?"
> **Domain expert:** "No. Default job percentiles include only successful jobs from successful tracked workflow attempts."
>
> **Dev:** "Is workflow P90 only runtime?"
> **Domain expert:** "No. Workflow percentiles include total duration, queue duration, and runtime; total duration is the primary user-facing metric."
>
> **Dev:** "Does workflow queue P90 use failed or cancelled attempts?"
> **Domain expert:** "No. Workflow total, queue, and runtime percentiles use successful tracked workflow attempts only."
>
> **Dev:** "Can step-level non-success analysis explain every failed workflow?"
> **Domain expert:** "No. Step-level non-success analysis is best-effort because failed workflow steps are not fully persisted."
>
> **Dev:** "Do job percentiles include job total duration?"
> **Domain expert:** "Yes. Job percentiles include total duration, queue duration, and runtime; total duration is the primary metric."
>
> **Dev:** "If a repository is listed but has no configured workflows, should it still appear in statistics?"
> **Domain expert:** "No. A repository must specify workflow match rules to be included in statistics."
>
> **Dev:** "Should collection fail if a configured workflow has no matching runs?"
> **Domain expert:** "No. Continue collection, but surface a **Missing Tracked Workflow** warning."
>
> **Dev:** "Can a repo config change merge before checking that the workflows exist?"
> **Domain expert:** "No. **Repository Configuration Validation** must run in CI for config changes."
>
> **Dev:** "Can config validation use extra GitHub workflow metadata calls?"
> **Domain expert:** "Yes. Validation may use GitHub workflows APIs, but daily collection should not."
>
> **Dev:** "Does every workflow use the same slow-step threshold?"
> **Domain expert:** "No. **Step Analysis Threshold** uses exact-ref workflow overrides first, then glob-ref workflow overrides, file-only workflow overrides, repository overrides, and defaults."
>
> **Dev:** "Can the same run count under two configured workflows?"
> **Domain expert:** "No. A run belongs to one **Tracked Workflow** at most, matched by workflow file basename and workflow ref."

## Flagged Ambiguities

- "All jobs" was used ambiguously. Resolved: job statistics mean all jobs under configured **Tracked Workflows**, not every GitHub Actions job in the repository.
- "Workflow name" can be duplicated or renamed without changing the workflow file. Resolved: **Workflow Match Rules** match workflow file basename only.
- "PR CI" could mean all workflows triggered by a pull request or only the configured analysis scope. Resolved: user-facing PR metrics use **Tracked PR CI**.
