/**
 * split-monolith-to-per-repo.ts
 *
 * Splits a monolithic SQLite database into per-repo databases.
 * Each repo gets its own `<owner>-<repo>.db` file with identical schema
 * but only that repo's data.
 *
 * Usage:
 *   npx tsx etl/scripts/split-monolith-to-per-repo.ts [options]
 *
 * Options:
 *   --source <path>   Path to monolithic DB (default: etl/data/action-insight.db)
 *   --output-dir <d>  Output directory (default: etl/data/)
 *   --min-runs <n>    Only export repos with >= N runs (default: 100)
 *   --repo <owner/repo>  Export only this repo (repeatable)
 */

import { createClient, type Client, type InValue } from '@libsql/client';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BATCH_SIZE = 5000;

/* Same schema as sqlite-storage.ts, minus PRAGMA foreign_keys: bulk split must
   tolerate legacy orphan rows in the source DB; the app connection
   (sqlite-storage.ts) sets PRAGMA foreign_keys = ON at runtime. */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id   INTEGER PRIMARY KEY, owner TEXT NOT NULL, repo  TEXT NOT NULL,
  UNIQUE(owner, repo)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, name TEXT, head_branch TEXT,
  head_sha TEXT, status TEXT, conclusion TEXT, event TEXT, created_at TEXT,
  updated_at TEXT, html_url TEXT, duration_seconds REAL, date TEXT,
  steps_checked_at TEXT,
  workflow_file TEXT, workflow_ref TEXT, workflow_path TEXT,
  workflow_parse_status TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, name TEXT, status TEXT,
  conclusion TEXT, created_at TEXT, started_at TEXT, completed_at TEXT,
  html_url TEXT, queue_duration_seconds REAL, duration_seconds REAL
);
CREATE TABLE IF NOT EXISTS steps (
  job_id INTEGER NOT NULL, number INTEGER NOT NULL, name TEXT, status TEXT,
  conclusion TEXT, started_at TEXT, completed_at TEXT, duration_seconds REAL,
  PRIMARY KEY (job_id, number)
);
CREATE TABLE IF NOT EXISTS pr_metrics (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, pr_number INTEGER NOT NULL,
  title TEXT, branch TEXT, author TEXT, state TEXT, html_url TEXT,
  created_at TEXT, ci_started_at TEXT, ci_completed_at TEXT, merged_at TEXT,
  partial_ci_history INTEGER DEFAULT 0, time_to_ci_start_seconds REAL,
  ci_duration_seconds REAL, time_to_merge_seconds REAL,
  merge_lead_time_seconds REAL, workflow_count INTEGER,
  successful_workflow_count INTEGER, conclusion TEXT,
  UNIQUE(repo_id, pr_number)
);
CREATE TABLE IF NOT EXISTS pr_workflows (
  pr_metric_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
  PRIMARY KEY (pr_metric_id, run_id)
);
CREATE TABLE IF NOT EXISTS pr_resolution_cache (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, head_sha TEXT NOT NULL,
  pr_number INTEGER, source TEXT, status TEXT, error_message TEXT,
  attempted_at TEXT, resolved_at TEXT, UNIQUE(repo_id, head_sha)
);
CREATE TABLE IF NOT EXISTS collection_state (
  repo_id INTEGER PRIMARY KEY, backfill_cursor TEXT,
  history_complete INTEGER DEFAULT 0, latest_date TEXT,
  retention_days INTEGER DEFAULT 90, last_updated TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_repo_id ON runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date);
CREATE INDEX IF NOT EXISTS idx_runs_repo_date ON runs(repo_id, date);
CREATE INDEX IF NOT EXISTS idx_runs_event ON runs(event);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo ON pr_metrics(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_metrics_repo_ci ON pr_metrics(repo_id, ci_completed_at);
CREATE INDEX IF NOT EXISTS idx_pr_resolution_cache_repo_sha ON pr_resolution_cache(repo_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_file ON runs(repo_id, workflow_file);

-- ADR-005: workflow file and attempt scoped collection (additive)
CREATE TABLE IF NOT EXISTS workflow_attempts (
  run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, conclusion TEXT, created_at TEXT, run_started_at TEXT,
  completed_at TEXT, updated_at TEXT, queue_duration_seconds REAL,
  runtime_seconds REAL, total_duration_seconds REAL,
  tracked INTEGER NOT NULL DEFAULT 0, workflow_file TEXT, workflow_ref TEXT,
	  match_kind TEXT, jobs_fetched_at TEXT, steps_eligibility_checked_at TEXT,
	  steps_collected_at TEXT, step_policy_hash TEXT,
	  PRIMARY KEY (run_id, run_attempt),
	  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
	);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_run ON workflow_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_tracked ON workflow_attempts(tracked, run_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_file ON workflow_attempts(workflow_file, workflow_ref);

CREATE TABLE IF NOT EXISTS workflow_jobs (
  run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL DEFAULT 1,
	  job_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
	  conclusion TEXT, created_at TEXT, started_at TEXT, completed_at TEXT,
	  html_url TEXT, queue_duration_seconds REAL, runtime_seconds REAL,
	  total_duration_seconds REAL, duration_seconds REAL,
	  PRIMARY KEY (run_id, run_attempt, job_id),
	  FOREIGN KEY (run_id, run_attempt) REFERENCES workflow_attempts(run_id, run_attempt) ON DELETE CASCADE
	);
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_attempt ON workflow_jobs(run_id, run_attempt);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id INTEGER NOT NULL, run_attempt INTEGER NOT NULL DEFAULT 1,
  job_id INTEGER NOT NULL, step_number INTEGER NOT NULL, name TEXT NOT NULL,
	  status TEXT NOT NULL, conclusion TEXT, started_at TEXT, completed_at TEXT,
	  duration_seconds REAL,
	  PRIMARY KEY (run_id, run_attempt, job_id, step_number),
	  FOREIGN KEY (run_id, run_attempt, job_id) REFERENCES workflow_jobs(run_id, run_attempt, job_id) ON DELETE CASCADE
	);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_job ON workflow_steps(run_id, run_attempt, job_id);

CREATE TABLE IF NOT EXISTS pr_workflow_attempts (
	  pr_metric_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
	  run_attempt INTEGER NOT NULL DEFAULT 1,
	  PRIMARY KEY (pr_metric_id, run_id, run_attempt),
	  FOREIGN KEY (run_id, run_attempt) REFERENCES workflow_attempts(run_id, run_attempt) ON DELETE CASCADE
	);
CREATE INDEX IF NOT EXISTS idx_pr_workflow_attempts_pr ON pr_workflow_attempts(pr_metric_id);
`;

interface CliOptions {
  source: string;
  outputDir: string;
  minRuns: number;
  repos: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    source: path.join(__dirname, '../data/action-insight.db'),
    outputDir: path.join(__dirname, '../data'),
    minRuns: 100,
    repos: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--source' && next) { opts.source = next; i++; }
    else if (arg === '--output-dir' && next) { opts.outputDir = next; i++; }
    else if (arg === '--min-runs' && next) { opts.minRuns = parseInt(next, 10); i++; }
    else if ((arg === '--repo' || arg === '-r') && next) { opts.repos.push(next); i++; }
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx etl/scripts/split-monolith-to-per-repo.ts [options]

Options:
  --source <path>       Path to monolithic DB (default: etl/data/action-insight.db)
  --output-dir <d>      Output directory (default: etl/data/)
  --min-runs <n>        Only export repos with >= N runs (default: 100)
  --repo, -r <o/r>      Export only this repo (repeatable)
  --help, -h            Show this help`);
      process.exit(0);
    }
  }

  return opts;
}

async function ensureSchema(client: Client): Promise<void> {
  for (const sql of SQLITE_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute({ sql, args: [] });
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

async function exportRepo(
  src: Client, dest: Client,
  owner: string, repo: string, repoId: number,
): Promise<{ table: string; count: number }[]> {
  await ensureSchema(dest);

  // Insert repo row with id = 1 (single repo per DB)
  await dest.execute({
    sql: 'INSERT INTO repos (id, owner, repo) VALUES (1, ?, ?) ON CONFLICT DO NOTHING',
    args: [owner, repo],
  });

  const results: { table: string; count: number }[] = [];
  const dbSafe = `${owner}-${repo}`;

  // ---- runs ----
  {
    const { rows } = await src.execute({
	      sql: 'SELECT id, name, head_branch, head_sha, status, conclusion, event, created_at, updated_at, html_url, duration_seconds, date, steps_checked_at, workflow_file, workflow_ref, workflow_path, workflow_parse_status FROM runs WHERE repo_id = ? ORDER BY id',
      args: [repoId],
    });
    if (rows.length === 0) { results.push({ table: dbSafe + '/runs', count: 0 }); return results; }
    console.log(`  ${dbSafe}: ${rows.length} runs...`);

    let count = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(r => ({
	        sql: 'INSERT INTO runs (id, repo_id, name, head_branch, head_sha, status, conclusion, event, created_at, updated_at, html_url, duration_seconds, date, steps_checked_at, workflow_file, workflow_ref, workflow_path, workflow_parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
	        args: [r.id as number, 1, r.name, r.head_branch, r.head_sha, r.status, r.conclusion, r.event, r.created_at, r.updated_at, r.html_url, r.duration_seconds, r.date, r.steps_checked_at, r.workflow_file, r.workflow_ref, r.workflow_path, r.workflow_parse_status] as InValue[],
	      }));
      const tx = await dest.transaction('write');
      try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
      count += batch.length;
    }
    results.push({ table: dbSafe + '/runs', count });
  }

  // ---- jobs ----
  {
    const { rows: countRow } = await src.execute({
      sql: 'SELECT count(*) as c FROM jobs j JOIN runs r ON j.run_id = r.id WHERE r.repo_id = ?',
      args: [repoId],
    });
    const totalJobs = Number(countRow[0].c);
    if (totalJobs === 0) { results.push({ table: dbSafe + '/jobs', count: 0 }); }
    else {
      console.log(`  ${dbSafe}: ${totalJobs} jobs...`);
      let count = 0;
      let offset = 0;
      while (true) {
        const { rows } = await src.execute({
          sql: `SELECT j.id, j.run_id, j.name, j.status, j.conclusion, j.created_at, j.started_at, j.completed_at, j.html_url, j.queue_duration_seconds, j.duration_seconds
                FROM jobs j JOIN runs r ON j.run_id = r.id WHERE r.repo_id = ? ORDER BY j.id LIMIT ? OFFSET ?`,
          args: [repoId, BATCH_SIZE, offset],
        });
        if (rows.length === 0) break;
        const stmts = rows.map(r => ({
          sql: 'INSERT INTO jobs (id, run_id, name, status, conclusion, created_at, started_at, completed_at, html_url, queue_duration_seconds, duration_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          args: [r.id as number, r.run_id as number, r.name, r.status, r.conclusion, r.created_at, r.started_at, r.completed_at, r.html_url, r.queue_duration_seconds, r.duration_seconds] as InValue[],
        }));
        const tx = await dest.transaction('write');
        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
        count += rows.length;
        offset += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
      }
      results.push({ table: dbSafe + '/jobs', count });
    }
  }

  // ---- steps ----
  {
    const { rows: countRow } = await src.execute({
      sql: 'SELECT count(*) as c FROM steps s JOIN jobs j ON s.job_id = j.id JOIN runs r ON j.run_id = r.id WHERE r.repo_id = ?',
      args: [repoId],
    });
    const totalSteps = Number(countRow[0].c);
    if (totalSteps === 0) { results.push({ table: dbSafe + '/steps', count: 0 }); }
    else {
      console.log(`  ${dbSafe}: ${totalSteps} steps...`);
      let count = 0;
      let offset = 0;
      while (true) {
        const { rows } = await src.execute({
          sql: `SELECT s.job_id, s.number, s.name, s.status, s.conclusion, s.started_at, s.completed_at, s.duration_seconds
                FROM steps s JOIN jobs j ON s.job_id = j.id JOIN runs r ON j.run_id = r.id WHERE r.repo_id = ? ORDER BY s.job_id, s.number LIMIT ? OFFSET ?`,
          args: [repoId, BATCH_SIZE, offset],
        });
        if (rows.length === 0) break;
        const stmts = rows.map(r => ({
          sql: 'INSERT INTO steps (job_id, number, name, status, conclusion, started_at, completed_at, duration_seconds) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          args: [r.job_id as number, r.number as number, r.name, r.status, r.conclusion, r.started_at, r.completed_at, r.duration_seconds] as InValue[],
        }));
        const tx = await dest.transaction('write');
        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
        count += rows.length;
        offset += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
      }
      results.push({ table: dbSafe + '/steps', count });
    }
	  }

	  // ---- workflow_attempts ----
	  {
	    const { rows } = await src.execute({
	      sql: `SELECT wa.run_id, wa.run_attempt, wa.status, wa.conclusion, wa.created_at,
	                   wa.run_started_at, wa.completed_at, wa.updated_at,
	                   wa.queue_duration_seconds, wa.runtime_seconds, wa.total_duration_seconds,
	                   wa.tracked, wa.workflow_file, wa.workflow_ref, wa.match_kind,
	                   wa.jobs_fetched_at, wa.steps_eligibility_checked_at,
	                   wa.steps_collected_at, wa.step_policy_hash
	            FROM workflow_attempts wa
	            JOIN runs r ON r.id = wa.run_id
	            WHERE r.repo_id = ?
	            ORDER BY wa.run_id, wa.run_attempt`,
	      args: [repoId],
	    }).catch(() => ({ rows: [] }));
	    if (rows.length > 0) {
	      let count = 0;
	      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
	        const batch = rows.slice(i, i + BATCH_SIZE);
	        const stmts = batch.map(r => ({
	          sql: `INSERT INTO workflow_attempts (
	                  run_id, run_attempt, status, conclusion, created_at, run_started_at,
	                  completed_at, updated_at, queue_duration_seconds, runtime_seconds,
	                  total_duration_seconds, tracked, workflow_file, workflow_ref, match_kind,
	                  jobs_fetched_at, steps_eligibility_checked_at, steps_collected_at, step_policy_hash
	                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
	          args: [r.run_id, r.run_attempt, r.status, r.conclusion, r.created_at, r.run_started_at, r.completed_at, r.updated_at, r.queue_duration_seconds, r.runtime_seconds, r.total_duration_seconds, r.tracked, r.workflow_file, r.workflow_ref, r.match_kind, r.jobs_fetched_at, r.steps_eligibility_checked_at, r.steps_collected_at, r.step_policy_hash] as InValue[],
	        }));
	        const tx = await dest.transaction('write');
	        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
	        count += batch.length;
	      }
	      results.push({ table: dbSafe + '/workflow_attempts', count });
	    }
	  }

	  // ---- workflow_jobs ----
	  {
	    const { rows } = await src.execute({
	      sql: `SELECT wj.run_id, wj.run_attempt, wj.job_id, wj.name, wj.status,
	                   wj.conclusion, wj.created_at, wj.started_at, wj.completed_at,
	                   wj.html_url, wj.queue_duration_seconds, wj.runtime_seconds,
	                   wj.total_duration_seconds, wj.duration_seconds
	            FROM workflow_jobs wj
	            JOIN runs r ON r.id = wj.run_id
	            WHERE r.repo_id = ?
	            ORDER BY wj.run_id, wj.run_attempt, wj.job_id`,
	      args: [repoId],
	    }).catch(() => ({ rows: [] }));
	    if (rows.length > 0) {
	      let count = 0;
	      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
	        const batch = rows.slice(i, i + BATCH_SIZE);
	        const stmts = batch.map(r => ({
	          sql: `INSERT INTO workflow_jobs (
	                  run_id, run_attempt, job_id, name, status, conclusion, created_at,
	                  started_at, completed_at, html_url, queue_duration_seconds,
	                  runtime_seconds, total_duration_seconds, duration_seconds
	                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
	          args: [r.run_id, r.run_attempt, r.job_id, r.name, r.status, r.conclusion, r.created_at, r.started_at, r.completed_at, r.html_url, r.queue_duration_seconds, r.runtime_seconds, r.total_duration_seconds, r.duration_seconds] as InValue[],
	        }));
	        const tx = await dest.transaction('write');
	        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
	        count += batch.length;
	      }
	      results.push({ table: dbSafe + '/workflow_jobs', count });
	    }
	  }

	  // ---- workflow_steps ----
	  {
	    const { rows } = await src.execute({
	      sql: `SELECT ws.run_id, ws.run_attempt, ws.job_id, ws.step_number, ws.name,
	                   ws.status, ws.conclusion, ws.started_at, ws.completed_at, ws.duration_seconds
	            FROM workflow_steps ws
	            JOIN runs r ON r.id = ws.run_id
	            WHERE r.repo_id = ?
	            ORDER BY ws.run_id, ws.run_attempt, ws.job_id, ws.step_number`,
	      args: [repoId],
	    }).catch(() => ({ rows: [] }));
	    if (rows.length > 0) {
	      let count = 0;
	      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
	        const batch = rows.slice(i, i + BATCH_SIZE);
	        const stmts = batch.map(r => ({
	          sql: `INSERT INTO workflow_steps (run_id, run_attempt, job_id, step_number, name, status, conclusion, started_at, completed_at, duration_seconds)
	                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
	          args: [r.run_id, r.run_attempt, r.job_id, r.step_number, r.name, r.status, r.conclusion, r.started_at, r.completed_at, r.duration_seconds] as InValue[],
	        }));
	        const tx = await dest.transaction('write');
	        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
	        count += batch.length;
	      }
	      results.push({ table: dbSafe + '/workflow_steps', count });
	    }
	  }

	  // ---- pr_metrics ----
  {
    const { rows } = await src.execute({
      sql: 'SELECT id, pr_number, title, branch, author, state, html_url, created_at, ci_started_at, ci_completed_at, merged_at, partial_ci_history, time_to_ci_start_seconds, ci_duration_seconds, time_to_merge_seconds, merge_lead_time_seconds, workflow_count, successful_workflow_count, conclusion FROM pr_metrics WHERE repo_id = ? ORDER BY id',
      args: [repoId],
    });
    if (rows.length > 0) {
      console.log(`  ${dbSafe}: ${rows.length} pr_metrics...`);
      let count = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const stmts = batch.map(r => ({
          sql: 'INSERT INTO pr_metrics (id, repo_id, pr_number, title, branch, author, state, html_url, created_at, ci_started_at, ci_completed_at, merged_at, partial_ci_history, time_to_ci_start_seconds, ci_duration_seconds, time_to_merge_seconds, merge_lead_time_seconds, workflow_count, successful_workflow_count, conclusion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          args: [r.id as number, 1, r.pr_number as number, r.title ?? null, r.branch ?? null, r.author ?? null, r.state ?? null, r.html_url ?? null, r.created_at ?? null, r.ci_started_at ?? null, r.ci_completed_at ?? null, r.merged_at ?? null, r.partial_ci_history ?? 0, r.time_to_ci_start_seconds ?? null, r.ci_duration_seconds ?? null, r.time_to_merge_seconds ?? null, r.merge_lead_time_seconds ?? null, r.workflow_count ?? null, r.successful_workflow_count ?? null, r.conclusion ?? null] as InValue[],
        }));
        const tx = await dest.transaction('write');
        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
        count += batch.length;
      }
      results.push({ table: dbSafe + '/pr_metrics', count });
    }
  }

	  // ---- pr_workflows (needs remapping pr_metric_id) ----
	  {
    // Build old_id -> new_id map
    const { rows: pmRows } = await src.execute({
      sql: 'SELECT id, pr_number FROM pr_metrics WHERE repo_id = ?',
      args: [repoId],
    });
    const idMap = new Map<number, number>();
    for (const r of pmRows) idMap.set(Number(r.id), Number(r.pr_number));

    // pr_workflows: (pr_metric_id, run_id) → need to remap pr_metric_id via pr_number
    const { rows } = await src.execute({
      sql: `SELECT pw.pr_metric_id, pw.run_id FROM pr_workflows pw JOIN pr_metrics pm ON pw.pr_metric_id = pm.id WHERE pm.repo_id = ?`,
      args: [repoId],
    });
    if (rows.length > 0) {
      // Need to look up new pr_metric ids by pr_number
      const { rows: newPm } = await dest.execute('SELECT id, pr_number FROM pr_metrics');
      const newIdMap = new Map<number, number>();
      for (const r of newPm) newIdMap.set(Number(r.pr_number), Number(r.id));

      console.log(`  ${dbSafe}: ${rows.length} pr_workflows...`);
      let count = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const stmts: { sql: string; args: InValue[] }[] = [];
        for (const r of batch) {
          const oldPmId = Number(r.pr_metric_id);
          const prNum = idMap.get(oldPmId);
          const newPmId = prNum !== undefined ? newIdMap.get(prNum) : undefined;
          if (newPmId !== undefined) {
            stmts.push({
              sql: 'INSERT INTO pr_workflows (pr_metric_id, run_id) VALUES (?,?) ON CONFLICT DO NOTHING',
              args: [newPmId, r.run_id as number],
            });
          }
        }
        if (stmts.length > 0) {
          const tx = await dest.transaction('write');
          try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
          count += stmts.length;
        }
      }
	      results.push({ table: dbSafe + '/pr_workflows', count });
	    }
	  }

	  // ---- pr_workflow_attempts (needs remapping pr_metric_id) ----
	  {
	    const { rows: pmRows } = await src.execute({
	      sql: 'SELECT id, pr_number FROM pr_metrics WHERE repo_id = ?',
	      args: [repoId],
	    });
	    const idMap = new Map<number, number>();
	    for (const r of pmRows) idMap.set(Number(r.id), Number(r.pr_number));

	    const { rows } = await src.execute({
	      sql: `SELECT pwa.pr_metric_id, pwa.run_id, pwa.run_attempt
	            FROM pr_workflow_attempts pwa
	            JOIN pr_metrics pm ON pwa.pr_metric_id = pm.id
	            WHERE pm.repo_id = ?`,
	      args: [repoId],
	    }).catch(() => ({ rows: [] }));
	    if (rows.length > 0) {
	      const { rows: newPm } = await dest.execute('SELECT id, pr_number FROM pr_metrics');
	      const newIdMap = new Map<number, number>();
	      for (const r of newPm) newIdMap.set(Number(r.pr_number), Number(r.id));

	      let count = 0;
	      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
	        const batch = rows.slice(i, i + BATCH_SIZE);
	        const stmts: { sql: string; args: InValue[] }[] = [];
	        for (const r of batch) {
	          const prNum = idMap.get(Number(r.pr_metric_id));
	          const newPmId = prNum !== undefined ? newIdMap.get(prNum) : undefined;
	          if (newPmId !== undefined) {
	            stmts.push({
	              sql: 'INSERT INTO pr_workflow_attempts (pr_metric_id, run_id, run_attempt) VALUES (?,?,?) ON CONFLICT DO NOTHING',
	              args: [newPmId, r.run_id as number, r.run_attempt as number],
	            });
	          }
	        }
	        if (stmts.length > 0) {
	          const tx = await dest.transaction('write');
	          try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
	          count += stmts.length;
	        }
	      }
	      results.push({ table: dbSafe + '/pr_workflow_attempts', count });
	    }
	  }

	  // ---- pr_resolution_cache ----
  {
    const { rows } = await src.execute({
      sql: 'SELECT id, head_sha, pr_number, source, status, error_message, attempted_at, resolved_at FROM pr_resolution_cache WHERE repo_id = ? ORDER BY id',
      args: [repoId],
    });
    if (rows.length > 0) {
      console.log(`  ${dbSafe}: ${rows.length} pr_resolution_cache...`);
      let count = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const stmts = batch.map(r => ({
          sql: 'INSERT INTO pr_resolution_cache (id, repo_id, head_sha, pr_number, source, status, error_message, attempted_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          args: [r.id as number, 1, r.head_sha, r.pr_number, r.source, r.status, r.error_message, r.attempted_at, r.resolved_at] as InValue[],
        }));
        const tx = await dest.transaction('write');
        try { await tx.batch(stmts); await tx.commit(); } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
        count += batch.length;
      }
      results.push({ table: dbSafe + '/pr_resolution_cache', count });
    }
  }

  // ---- collection_state ----
  {
    const { rows } = await src.execute({
      sql: 'SELECT backfill_cursor, history_complete, latest_date, retention_days, last_updated FROM collection_state WHERE repo_id = ?',
      args: [repoId],
    });
    if (rows.length > 0) {
      const r = rows[0];
      await dest.execute({
        sql: 'INSERT INTO collection_state (repo_id, backfill_cursor, history_complete, latest_date, retention_days, last_updated) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        args: [1, r.backfill_cursor, r.history_complete, r.latest_date, r.retention_days, r.last_updated] as InValue[],
      });
      results.push({ table: dbSafe + '/collection_state', count: 1 });
    }
  }

  return results;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.source)) {
    console.error(`❌ Source database not found: ${opts.source}`);
    process.exit(1);
  }

  const src = createClient({ url: `file:${opts.source}` });
  await src.execute('SELECT 1');
  console.log(`📦 Source: ${opts.source}`);
  console.log(`📂 Output: ${opts.outputDir}`);
  fs.mkdirSync(opts.outputDir, { recursive: true });

  // Determine which repos to export
  let repoRows: Array<{ owner: string; repo: string; id: number; run_count: number }>;
  if (opts.repos.length > 0) {
    // Export only specified repos
    const placeholders = opts.repos.map(() => '(?, ?)').join(' OR (r.owner, r.repo) = ');
    const args: (string | number)[] = [];
    for (const r of opts.repos) {
      const [o, rp] = r.split('/');
      args.push(o, rp);
    }
    const { rows } = await src.execute({
      sql: `SELECT r.id, r.owner, r.repo, COUNT(ru.id) as run_count
            FROM repos r LEFT JOIN runs ru ON ru.repo_id = r.id
            WHERE (r.owner, r.repo) = (${placeholders})
            GROUP BY r.id, r.owner, r.repo`,
      args,
    });
    repoRows = rows as unknown as typeof repoRows;
  } else {
    const { rows } = await src.execute({
      sql: `SELECT r.id, r.owner, r.repo, COUNT(ru.id) as run_count
            FROM repos r LEFT JOIN runs ru ON ru.repo_id = r.id
            GROUP BY r.id, r.owner, r.repo
            HAVING COUNT(ru.id) >= ?
            ORDER BY run_count DESC`,
      args: [opts.minRuns],
    });
    repoRows = rows as unknown as typeof repoRows;
  }

  console.log(`\nExporting ${repoRows.length} repo(s)...\n`);

  const allResults: { table: string; count: number }[] = [];
  const startMs = Date.now();

  for (const { id, owner, repo, run_count } of repoRows) {
    const dbPath = path.join(opts.outputDir, `${owner}-${repo}.db`);
    // Remove existing to start fresh
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const dest = createClient({ url: `file:${dbPath}` });
    const tableStart = Date.now();

    try {
      const results = await exportRepo(src, dest, owner, repo, id);
      const duration = Date.now() - tableStart;
      const totalRows = results.reduce((s, r) => s + r.count, 0);
      console.log(`  ✅ ${owner}/${repo}: ${totalRows} rows in ${formatDuration(duration)}\n`);
      allResults.push(...results);
    } catch (e) {
      console.error(`  ❌ Failed to export ${owner}/${repo}:`, e);
    } finally {
      // Compress the output
      const { execFileSync } = await import('child_process');
      try {
        execFileSync('xz', ['-f', '--force', dbPath], { stdio: 'pipe' });
        console.log(`  📦 Compressed to ${dbPath}.xz`);
      } catch {
        // Compression is optional
      }
    }
  }

  console.log('─'.repeat(60));
  let totalRows = 0;
  for (const { table, count } of allResults) {
    console.log(`  ${table.padEnd(50)} ${String(count).padStart(8)} rows`);
    totalRows += count;
  }
  console.log('─'.repeat(60));
  console.log(`Total: ${totalRows} rows in ${formatDuration(Date.now() - startMs)}`);
  console.log('\n✅ Split complete!');
}

main().catch(err => { console.error('❌', err); process.exit(1); });
