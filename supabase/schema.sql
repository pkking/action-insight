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
  date DATE NOT NULL  -- Denormalized for efficient date-range queries
);

-- Index for common query patterns: by repo + date range
CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date DESC);
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

-- 6. Collection state table (replaces local index.json)
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
