-- Action Insight Turso Schema (SQLite)
-- Run this SQL in Turso shell: turso db shell <database-name> < schema.sql

PRAGMA foreign_keys = ON;

-- 1. Repos table
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  UNIQUE(owner, repo)
);

-- 2. Runs table (workflow runs)
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,  -- GitHub run ID (SQLite INTEGER stores 64-bit signed)
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  head_sha TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  event TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  html_url TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  steps_checked_at TEXT,
  -- ADR-005: workflow file/ref metadata parsed from the run path. Additive;
  -- NULL until workflow file backfill populates them.
  workflow_file TEXT,
  workflow_ref TEXT,
  workflow_path TEXT,
  workflow_parse_status TEXT  -- 'ok' | 'ref_unavailable' | 'file_unavailable'
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_repo_id_id ON runs(repo_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_file ON runs(repo_id, workflow_file);

-- 3. Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  html_url TEXT NOT NULL,
  queue_duration_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

-- 3b. Steps table
CREATE TABLE IF NOT EXISTS steps (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_seconds INTEGER DEFAULT 0,
  PRIMARY KEY (job_id, number)
);

-- 4. PR Metrics table
CREATE TABLE IF NOT EXISTS pr_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  author TEXT,
  state TEXT NOT NULL,
  html_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ci_started_at TEXT,
  ci_completed_at TEXT,
  merged_at TEXT,
  partial_ci_history INTEGER NOT NULL DEFAULT 0,
  time_to_ci_start_seconds INTEGER,
  ci_duration_seconds INTEGER,
  time_to_merge_seconds INTEGER,
  merge_lead_time_seconds INTEGER,
  workflow_count INTEGER NOT NULL DEFAULT 0,
  successful_workflow_count INTEGER NOT NULL DEFAULT 0,
  conclusion TEXT,
  UNIQUE(repo_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo ON pr_metrics(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_created ON pr_metrics(created_at DESC);

-- 5. PR Workflows table
CREATE TABLE IF NOT EXISTS pr_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_metric_id INTEGER NOT NULL REFERENCES pr_metrics(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  UNIQUE(pr_metric_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_workflows_pr ON pr_workflows(pr_metric_id);
CREATE INDEX IF NOT EXISTS idx_pr_workflows_run ON pr_workflows(run_id);

-- 6. PR resolution cache
CREATE TABLE IF NOT EXISTS pr_resolution_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  head_sha TEXT NOT NULL,
  pr_number INTEGER,
  source TEXT NOT NULL DEFAULT 'commits_api',
  status TEXT NOT NULL DEFAULT 'resolved',
  error_message TEXT,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  UNIQUE(repo_id, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_repo_sha ON pr_resolution_cache(repo_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_status ON pr_resolution_cache(repo_id, status);

-- 7. Collection state table
CREATE TABLE IF NOT EXISTS collection_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  backfill_cursor TEXT,
  history_complete INTEGER NOT NULL DEFAULT 0,
  latest_date TEXT,
  retention_days INTEGER NOT NULL DEFAULT 90,
  last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(repo_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_state_repo ON collection_state(repo_id);

-- 8. Test case statistics
CREATE TABLE IF NOT EXISTS test_case_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  total_test_cases INTEGER NOT NULL DEFAULT 0,
  ascend_test_cases INTEGER NOT NULL DEFAULT 0,
  nvidia_test_cases INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(repo_id, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_test_case_stats_repo ON test_case_stats(repo_id);
CREATE INDEX IF NOT EXISTS idx_test_case_stats_window ON test_case_stats(window_start, window_end);

-- =====================================================================
-- ADR-005: Workflow file and attempt scoped collection
-- Attempt-scoped execution records. Additive: existing run/job/step reads are
-- unchanged. These tables are populated by later ETL units; the schema is
-- committed first so migrations are safe and idempotent.
-- =====================================================================

-- 9. Workflow attempts: one execution of a tracked workflow, keyed by
-- GitHub run_id + run_attempt (reruns are separate rows).
CREATE TABLE IF NOT EXISTS workflow_attempts (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,           -- GitHub run status
  conclusion TEXT,
  created_at TEXT,                -- workflow run created_at
  run_started_at TEXT,            -- run_started_at (start of Workflow Runtime)
  completed_at TEXT,              -- Workflow Completion Time
  updated_at TEXT,
  queue_duration_seconds REAL,    -- Workflow Queue Duration
  runtime_seconds REAL,           -- Workflow Runtime
  total_duration_seconds REAL,    -- Workflow Total Duration
  tracked INTEGER NOT NULL DEFAULT 0,
  workflow_file TEXT,
  workflow_ref TEXT,
  match_kind TEXT,                -- 'exact_ref' | 'glob_ref' | 'file_only'
  jobs_fetched_at TEXT,
  steps_eligibility_checked_at TEXT,
  steps_collected_at TEXT,
  step_policy_hash TEXT,
  PRIMARY KEY (run_id, run_attempt)
);

CREATE INDEX IF NOT EXISTS idx_workflow_attempts_run ON workflow_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_tracked ON workflow_attempts(tracked, run_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_file ON workflow_attempts(workflow_file, workflow_ref);

-- 10. Attempt-scoped jobs (Job Attempt Identity: run_id + run_attempt + job_id)
CREATE TABLE IF NOT EXISTS workflow_jobs (
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  job_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  created_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  html_url TEXT,
  queue_duration_seconds REAL,    -- Job Queue Duration
  duration_seconds REAL,          -- Job Total Duration
  PRIMARY KEY (run_id, run_attempt, job_id),
  FOREIGN KEY (run_id, run_attempt) REFERENCES workflow_attempts(run_id, run_attempt) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_jobs_attempt ON workflow_jobs(run_id, run_attempt);

-- 11. Attempt-scoped steps (Step Attempt Identity: run_id + run_attempt + job_id + step_number)
-- Steps are persisted only for Slow Successful Workflows (ADR-005).
CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  job_id INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_seconds REAL,          -- Step Runtime only (no queue/total)
  PRIMARY KEY (run_id, run_attempt, job_id, step_number),
  FOREIGN KEY (run_id, run_attempt, job_id) REFERENCES workflow_jobs(run_id, run_attempt, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_job ON workflow_steps(run_id, run_attempt, job_id);

-- 12. PR workflow attempt links (replaces run-level pr_workflows links for
-- attempt-scoped metrics; pr_workflows retained for compatibility).
CREATE TABLE IF NOT EXISTS pr_workflow_attempts (
  pr_metric_id INTEGER NOT NULL REFERENCES pr_metrics(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (pr_metric_id, run_id, run_attempt),
  FOREIGN KEY (run_id, run_attempt) REFERENCES workflow_attempts(run_id, run_attempt) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pr_workflow_attempts_pr ON pr_workflow_attempts(pr_metric_id);
