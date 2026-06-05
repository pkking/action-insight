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
  steps_checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_repo_id_id ON runs(repo_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);

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
  run_id INTEGER NOT NULL REFERENCES runs(id),
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
