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
  github_payload JSONB,
  date DATE NOT NULL  -- Denormalized for efficient date-range queries
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
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  github_payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

-- Existing deployments created by earlier versions need additive columns.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS github_payload JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS github_payload JSONB;

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
