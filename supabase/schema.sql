-- Action Insight Supabase Schema
-- Run this SQL in the Supabase SQL Editor to create all tables.

-- 1. Repos table
CREATE TABLE IF NOT EXISTS repos (
  id SERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  UNIQUE(owner, repo)
);

-- 2. Runs table (workflow runs)
CREATE TABLE IF NOT EXISTS runs (
  id BIGINT PRIMARY KEY,  -- GitHub run ID
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  head_sha TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  event TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  html_url TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  date DATE NOT NULL,  -- Denormalized for efficient date-range queries
  steps_checked_at TIMESTAMPTZ  -- Tracks when steps were last checked; NULL means never checked
);

-- Index for common query patterns: by repo + date range
CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_repo_id_id ON runs(repo_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);

-- 3. Jobs table (individual jobs within runs)
CREATE TABLE IF NOT EXISTS jobs (
  id BIGINT PRIMARY KEY,  -- GitHub job ID
  run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  html_url TEXT NOT NULL,
  queue_duration_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

-- 3b. Steps table (individual steps within jobs)
CREATE TABLE IF NOT EXISTS steps (
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,  -- step position within the job (1-based)
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  PRIMARY KEY (job_id, number)
);

-- 4. PR Metrics table (PR-level CI metrics summaries)
CREATE TABLE IF NOT EXISTS pr_metrics (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  author TEXT,
  state TEXT NOT NULL,
  html_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ci_started_at TIMESTAMPTZ,
  ci_completed_at TIMESTAMPTZ,
  merged_at TIMESTAMPTZ,
  partial_ci_history BOOLEAN NOT NULL DEFAULT false,
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

-- 5. PR Workflows table (workflows linked to specific PRs)
CREATE TABLE IF NOT EXISTS pr_workflows (
  id SERIAL PRIMARY KEY,
  pr_metric_id INTEGER NOT NULL REFERENCES pr_metrics(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES runs(id),
  UNIQUE(pr_metric_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_workflows_pr ON pr_workflows(pr_metric_id);

-- 6. PR resolution cache (commit SHA -> PR number)
CREATE TABLE IF NOT EXISTS pr_resolution_cache (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  head_sha TEXT NOT NULL,
  pr_number INTEGER,
  source TEXT NOT NULL DEFAULT 'commits_api',
  status TEXT NOT NULL DEFAULT 'resolved',
  error_message TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(repo_id, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_repo_sha ON pr_resolution_cache(repo_id, head_sha);

ALTER TABLE pr_resolution_cache ALTER COLUMN pr_number DROP NOT NULL;
ALTER TABLE pr_resolution_cache ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'resolved';
ALTER TABLE pr_resolution_cache ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE pr_resolution_cache ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE pr_resolution_cache ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE pr_resolution_cache ALTER COLUMN resolved_at DROP NOT NULL;
ALTER TABLE pr_resolution_cache ALTER COLUMN resolved_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_status ON pr_resolution_cache(repo_id, status);

-- 7. Collection state table (replaces local index.json)
CREATE TABLE IF NOT EXISTS collection_state (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  backfill_cursor DATE,
  history_complete BOOLEAN NOT NULL DEFAULT false,
  latest_date DATE,
  retention_days INTEGER NOT NULL DEFAULT 90,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repo_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_state_repo ON collection_state(repo_id);

-- 8. RPC: Get run IDs that already have jobs for a repo (server-side EXISTS)
-- Usage: SELECT * FROM get_run_ids_with_jobs(repo_id);
CREATE OR REPLACE FUNCTION get_run_ids_with_jobs(p_repo_id INTEGER)
RETURNS TABLE(run_id BIGINT) AS $$
BEGIN
  RETURN QUERY
    SELECT r.id
    FROM runs r
    WHERE r.repo_id = p_repo_id
      AND EXISTS (
        SELECT 1
        FROM jobs j
        WHERE j.run_id = r.id
      )
    ORDER BY r.id;
END;
$$ LANGUAGE plpgsql;

-- 9. RPC: Get distinct dates for a repo (server-side DISTINCT)
-- Usage: SELECT * FROM get_distinct_dates(repo_id);
CREATE OR REPLACE FUNCTION get_distinct_dates(p_repo_id INTEGER)
RETURNS TABLE(date DATE) AS $$
BEGIN
  RETURN QUERY
    SELECT DISTINCT r.date
    FROM runs r
    WHERE r.repo_id = p_repo_id
    ORDER BY r.date DESC;
END;
$$ LANGUAGE plpgsql;

-- 10. RPC: Get run IDs where ALL non-skipped/non-cancelled jobs lack steps.
-- Usage: SELECT * FROM get_run_ids_missing_steps(repo_id, after_id);
-- Supports keyset pagination via p_after_id (pass 0 or NULL to start from beginning).
-- A run is returned ONLY if:
--   1. It has at least one eligible job (non-skipped/non-cancelled)
--   2. None of those jobs have steps
--   3. steps_checked_at IS NULL or is older than updated_at (needs re-check)
-- Runs with even a single job that has steps are excluded to prevent infinite retries.
-- After fetching, the ETL should set steps_checked_at = now() on the run.
CREATE OR REPLACE FUNCTION get_run_ids_missing_steps(p_repo_id INTEGER, p_after_id BIGINT DEFAULT 0)
RETURNS TABLE(run_id BIGINT) AS $$
BEGIN
  RETURN QUERY
    SELECT r.id
    FROM runs r
    WHERE r.repo_id = p_repo_id
      AND r.id > COALESCE(NULLIF(p_after_id, 0), 0)
      -- Has not been checked for steps, or was updated since last check
      AND (r.steps_checked_at IS NULL OR r.steps_checked_at < r.updated_at)
      -- Has at least one eligible (non-skipped/non-cancelled) job
      AND EXISTS (
        SELECT 1
        FROM jobs j
        WHERE j.run_id = r.id
          AND j.conclusion NOT IN ('skipped', 'cancelled')
      )
      -- None of the eligible jobs have steps
      AND NOT EXISTS (
        SELECT 1
        FROM jobs j
        INNER JOIN steps s ON s.job_id = j.id
        WHERE j.run_id = r.id
          AND j.conclusion NOT IN ('skipped', 'cancelled')
      )
    ORDER BY r.id
    LIMIT 1000;
END;
$$ LANGUAGE plpgsql;

-- 10. Test case statistics (per repo, per window)
CREATE TABLE IF NOT EXISTS test_case_stats (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  total_test_cases INTEGER NOT NULL DEFAULT 0,
  ascend_test_cases INTEGER NOT NULL DEFAULT 0,
  nvidia_test_cases INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repo_id, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_test_case_stats_repo ON test_case_stats(repo_id);
CREATE INDEX IF NOT EXISTS idx_test_case_stats_window ON test_case_stats(window_start, window_end);
