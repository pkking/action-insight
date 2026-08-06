import { getDatabaseClient, query, getRepoId } from './db';
import { toPgSql, pgPlaceholders } from './pg-utils';
import type { Index, DayData, Run, Job, Step } from './types';

function mapRunRow(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    name: row.name as string,
    head_branch: row.head_branch as string,
    head_sha: row.head_sha as string | undefined,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    event: row.event as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    html_url: row.html_url as string,
    durationInSeconds: Number(row.duration_seconds),
    pull_requests: [],
    jobs: [],
  };
}

function mapJobRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id),
    name: row.name as string,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    created_at: row.created_at as string,
    started_at: row.started_at as string,
    completed_at: row.completed_at as string,
    html_url: row.html_url as string,
    queueDurationInSeconds: Number(row.queue_duration_seconds),
    durationInSeconds: Number(row.duration_seconds),
  };
}

function mapStepRow(row: Record<string, unknown>): Step {
  return {
    name: (row.name as string) || '',
    status: (row.status as string) || 'unknown',
    conclusion: (row.conclusion as string) || 'unknown',
    started_at: (row.started_at as string) || undefined,
    completed_at: (row.completed_at as string) || undefined,
    number: Number(row.number ?? row.step_number),
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : undefined,
  };
}

function mapAttemptRunRow(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    runAttempt: Number(row.run_attempt),
    name: row.name as string,
    head_branch: row.head_branch as string,
    head_sha: row.head_sha as string | undefined,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    event: row.event as string | undefined,
    created_at: row.created_at as string,
    run_started_at: row.run_started_at as string || undefined,
    updated_at: ((row.completed_at as string) || (row.attempt_updated_at as string) || (row.updated_at as string)),
    html_url: row.html_url as string,
    durationInSeconds: Number(row.total_duration_seconds ?? row.runtime_seconds ?? row.duration_seconds ?? 0),
    queueDurationInSeconds: row.queue_duration_seconds == null ? undefined : Number(row.queue_duration_seconds),
    runtimeInSeconds: row.runtime_seconds == null ? undefined : Number(row.runtime_seconds),
    workflowFile: row.workflow_file as string | undefined,
    workflowRef: row.workflow_ref as string | undefined,
    workflowPath: row.workflow_path as string | undefined,
    workflowParseStatus: row.workflow_parse_status as Run['workflowParseStatus'],
    workflowMatchKind: row.match_kind as Run['workflowMatchKind'],
    stepPolicyHash: row.step_policy_hash as string | undefined,
    tracked: typeof row.tracked === 'number' ? Boolean(row.tracked) : undefined,
    pull_requests: [],
    jobs: [],
  };
}

function mapAttemptJobRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row.job_id),
    runAttempt: Number(row.run_attempt),
    name: row.name as string,
    status: row.status as string,
    conclusion: (row.conclusion as string) || '',
    created_at: row.created_at as string,
    started_at: row.started_at as string,
    completed_at: row.completed_at as string,
    html_url: row.html_url as string,
    queueDurationInSeconds: Number(row.queue_duration_seconds ?? 0),
    durationInSeconds: Number(row.runtime_seconds ?? row.duration_seconds ?? 0),
    runtimeInSeconds: row.runtime_seconds == null ? undefined : Number(row.runtime_seconds),
    totalDurationInSeconds: row.total_duration_seconds == null ? undefined : Number(row.total_duration_seconds),
  };
}

async function fetchStepsForJobs(jobIds: number[]): Promise<Map<number, Step[]>> {
  const uniqueJobIds = Array.from(new Set(jobIds));
  if (uniqueJobIds.length === 0) return new Map();
  const client = await getDatabaseClient();

  const stepsByJob = new Map<number, Step[]>();
  const CHUNK = 500;
  try {
    for (let i = 0; i < uniqueJobIds.length; i += CHUNK) {
      const chunk = uniqueJobIds.slice(i, i + CHUNK);
      const placeholders = pgPlaceholders(chunk.length);
      const { rows } = await client.query(
        toPgSql(`SELECT job_id, number, name, status, conclusion, started_at, completed_at, duration_seconds
            FROM steps WHERE job_id IN (${placeholders})
            ORDER BY job_id, number`),
        chunk,
      );

      for (const row of rows) {
        const jobId = Number(row.job_id);
        if (!stepsByJob.has(jobId)) stepsByJob.set(jobId, []);
        stepsByJob.get(jobId)!.push(mapStepRow(row));
      }
    }
  } finally {
    client.release();
  }

  return stepsByJob;
}

function attachStepsToRuns(runs: Run[], stepsByJob: Map<number, Step[]>): void {
  for (const run of runs) {
    if (run.jobs) {
      for (const job of run.jobs) {
        const steps = stepsByJob.get(job.id);
        if (steps && steps.length > 0) {
          job.steps = steps;
        }
      }
    }
  }
}

async function fetchStepsAndAttach(runs: Run[]): Promise<void> {
  const allJobIds = runs.flatMap((r) => r.jobs?.map((j) => j.id) ?? []);
  const stepsByJob = await fetchStepsForJobs(allJobIds);
  attachStepsToRuns(runs, stepsByJob);
}

export async function fetchAttemptStepsAndAttach(runs: Run[]): Promise<void> {
  const jobKeys = runs.flatMap((run) =>
    (run.jobs ?? []).map((job) => ({
      runId: run.id,
      runAttempt: run.runAttempt ?? 1,
      jobId: job.id,
    })),
  );
  if (jobKeys.length === 0) return;

  const client = await getDatabaseClient();
  const stepsByJob = new Map<string, Step[]>();
  const chunkSize = 100;
  try {
    for (let i = 0; i < jobKeys.length; i += chunkSize) {
      const chunk = jobKeys.slice(i, i + chunkSize);
      const clauses = chunk.map((_, idx) =>
        `(run_id = $${idx * 3 + 1} AND run_attempt = $${idx * 3 + 2} AND job_id = $${idx * 3 + 3})`,
      ).join(' OR ');
      const params = chunk.flatMap((job) => [job.runId, job.runAttempt, job.jobId]);

      let rows: Record<string, unknown>[] = [];
      try {
        const result = await client.query(
          `SELECT run_id, run_attempt, job_id, step_number, name, status, conclusion, started_at, completed_at, duration_seconds
            FROM workflow_steps
            WHERE ${clauses}
            ORDER BY run_id, run_attempt, job_id, step_number`,
          params,
        );
        rows = result.rows as Record<string, unknown>[];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('does not exist')) {
          rows = [];
        } else {
          throw error;
        }
      }

      for (const row of rows) {
        const key = `${Number(row.run_id)}:${Number(row.run_attempt)}:${Number(row.job_id)}`;
        if (!stepsByJob.has(key)) stepsByJob.set(key, []);
        stepsByJob.get(key)!.push(mapStepRow(row));
      }
    }
  } finally {
    client.release();
  }

  for (const run of runs) {
    for (const job of run.jobs ?? []) {
      const key = `${run.id}:${run.runAttempt ?? 1}:${job.id}`;
      const steps = stepsByJob.get(key);
      if (steps && steps.length > 0) {
        job.steps = steps;
      }
    }
  }
}

export interface FetchRunsOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  now?: Date;
  includeSteps?: boolean;
}

export async function fetchIndex(owner: string, repo: string): Promise<Index> {
  const repoId = await getRepoId(owner, repo);

  const { rows: dateRows } = await query(
    `SELECT date FROM runs WHERE repo_id = $1 ORDER BY date DESC`,
    [repoId],
  );

  const uniqueDates = [...new Set(dateRows.map((d) => d.date as string))];
  const files = uniqueDates.map((d) => `${d}.json`);
  const latest = files[0]?.replace('.json', '') || '';

  return {
    version: 1,
    latest,
    files,
    retention_days: 90,
    last_updated: new Date().toISOString(),
    history_complete: true,
  };
}

export async function fetchDay(owner: string, repo: string, fileName: string): Promise<DayData> {
  const date = fileName.replace('.json', '');
  const repoId = await getRepoId(owner, repo);

  const attemptRuns = await fetchAttemptRunsFromDb(repoId, { startDate: date, endDate: date, includeSteps: true });
  if (attemptRuns.length > 0) {
    return { date, repo: `${owner}/${repo}`, runs: attemptRuns };
  }

  // Fetch legacy runs with jobs via LEFT JOIN
  const client = await getDatabaseClient();
  try {
    const { rows } = await client.query(
      `SELECT r.id, r.name, r.head_branch, r.head_sha, r.status, r.conclusion,
               r.event, r.created_at, r.updated_at, r.html_url, r.duration_seconds, r.date,
               j.id AS job_id, j.name AS job_name, j.status AS job_status,
               j.conclusion AS job_conclusion, j.created_at AS job_created_at,
               j.started_at AS job_started_at, j.completed_at AS job_completed_at,
               j.html_url AS job_html_url,
               j.queue_duration_seconds, j.duration_seconds AS job_duration_seconds
        FROM runs r
        LEFT JOIN jobs j ON j.run_id = r.id
        WHERE r.repo_id = $1 AND r.date = $2
        ORDER BY r.created_at DESC, j.started_at ASC`,
      [repoId, date],
    );

    // Group by run
    const runMap = new Map<number, Run>();
    for (const row of rows) {
      const runId = Number(row.id);
      if (!runMap.has(runId)) {
        runMap.set(runId, { ...mapRunRow(row as Record<string, unknown>), jobs: [] });
      }
      if (row.job_id != null) {
        const run = runMap.get(runId)!;
        run.jobs!.push(mapJobRow({
          id: row.job_id,
          name: row.job_name,
          status: row.job_status,
          conclusion: row.job_conclusion,
          created_at: row.job_created_at,
          started_at: row.job_started_at,
          completed_at: row.job_completed_at,
          html_url: row.job_html_url,
          queue_duration_seconds: row.queue_duration_seconds,
          duration_seconds: row.job_duration_seconds,
        }));
      }
    }

    const mappedRuns = Array.from(runMap.values());

    // fetchDay always loads steps
    await fetchStepsAndAttach(mappedRuns);

    return { date, repo: `${owner}/${repo}`, runs: mappedRuns };
  } finally {
    client.release();
  }
}

async function fetchRunsFromDb(repoId: number, dateFilter: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  includeSteps?: boolean;
}): Promise<Run[]> {
  const attemptRuns = await fetchAttemptRunsFromDb(repoId, dateFilter);
  if (attemptRuns.length > 0) {
    return attemptRuns;
  }

  // Step 1: Query runs only (avoids LEFT JOIN + LIMIT truncation bug)
  let runsSql = `SELECT id, name, head_branch, head_sha, status, conclusion,
                        event, created_at, updated_at, html_url, duration_seconds, date
                 FROM runs WHERE repo_id = $1`;
  const runsArgs: (string | number)[] = [repoId];
  let paramIdx = 2;

  if (dateFilter.startDate && dateFilter.endDate) {
    runsSql += ` AND date >= $${paramIdx} AND date <= $${paramIdx + 1}`;
    runsArgs.push(dateFilter.startDate, dateFilter.endDate);
    paramIdx += 2;
  } else if (dateFilter.startDate) {
    runsSql += ` AND date >= $${paramIdx}`;
    runsArgs.push(dateFilter.startDate);
    paramIdx += 1;
  }

  runsSql += ` ORDER BY created_at DESC`;

  if (dateFilter.limit) {
    runsSql += ` LIMIT $${paramIdx}`;
    runsArgs.push(dateFilter.limit);
  }

  const { rows: runRows } = await query(runsSql, runsArgs);
  if (runRows.length === 0) return [];

  // Step 2: Batch-fetch jobs for these runs
  const runIds = runRows.map((r) => r.id as number);
  const placeholders = pgPlaceholders(runIds.length);
  const { rows: jobRows } = await query(
    `SELECT id, run_id, name, status, conclusion, created_at, started_at,
                 completed_at, html_url, queue_duration_seconds, duration_seconds
          FROM jobs WHERE run_id IN (${placeholders}) ORDER BY started_at ASC`,
    runIds,
  );

  const jobsByRun = new Map<number, Array<Record<string, unknown>>>();
  for (const row of jobRows) {
    const rid = Number(row.run_id);
    if (!jobsByRun.has(rid)) jobsByRun.set(rid, []);
    jobsByRun.get(rid)!.push(row);
  }

  const mappedRuns: Run[] = runRows.map((row) => {
    const runId = Number(row.id);
    const run: Run = {
      ...mapRunRow(row as Record<string, unknown>),
      jobs: (jobsByRun.get(runId) || []).map((j) => mapJobRow(j)),
    };
    return run;
  });

  if (dateFilter.includeSteps) {
    await fetchStepsAndAttach(mappedRuns);
  }

  return mappedRuns;
}

async function fetchAttemptRunsFromDb(repoId: number, dateFilter: {
  startDate?: string;
  endDate?: string;
  limit?: number;
  includeSteps?: boolean;
}): Promise<Run[]> {
  const client = await getDatabaseClient();
  try {
    let attemptsSql = `SELECT r.id, r.name, r.head_branch, r.head_sha, r.event, r.html_url,
                              r.workflow_path, r.workflow_parse_status, r.updated_at,
                              wa.run_attempt, wa.status, wa.conclusion, wa.created_at, wa.run_started_at,
                              wa.completed_at, wa.updated_at AS attempt_updated_at, wa.queue_duration_seconds,
                              wa.runtime_seconds, wa.total_duration_seconds, wa.tracked, wa.workflow_file,
                              wa.workflow_ref, wa.match_kind, wa.step_policy_hash
                       FROM workflow_attempts wa
                       JOIN runs r ON r.id = wa.run_id
                       WHERE r.repo_id = $1`;
    const attemptArgs: Array<string | number> = [repoId];
    let paramIdx = 2;

    if (dateFilter.startDate && dateFilter.endDate) {
      attemptsSql += ` AND r.date >= $${paramIdx} AND r.date <= $${paramIdx + 1}`;
      attemptArgs.push(dateFilter.startDate, dateFilter.endDate);
      paramIdx += 2;
    } else if (dateFilter.startDate) {
      attemptsSql += ` AND r.date >= $${paramIdx}`;
      attemptArgs.push(dateFilter.startDate);
      paramIdx += 1;
    } else if (dateFilter.endDate) {
      attemptsSql += ` AND r.date <= $${paramIdx}`;
      attemptArgs.push(dateFilter.endDate);
      paramIdx += 1;
    }

    attemptsSql += ` ORDER BY wa.created_at DESC, wa.run_id DESC, wa.run_attempt DESC`;
    if (dateFilter.limit) {
      attemptsSql += ` LIMIT $${paramIdx}`;
      attemptArgs.push(dateFilter.limit);
    }

    let attemptRows: Record<string, unknown>[] = [];
    try {
      const result = await client.query(attemptsSql, attemptArgs);
      attemptRows = result.rows as Record<string, unknown>[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('does not exist')) {
        return [];
      }
      throw error;
    }

    if (attemptRows.length === 0) return [];

    const attemptKeys = attemptRows.map((row) => ({
      runId: Number(row.id),
      runAttempt: Number(row.run_attempt),
    }));
    const jobRows: Record<string, unknown>[] = [];
    const chunkSize = 100;
    for (let i = 0; i < attemptKeys.length; i += chunkSize) {
      const chunk = attemptKeys.slice(i, i + chunkSize);
      const clauses = chunk.map((_, idx) =>
        `(run_id = $${idx * 2 + 1} AND run_attempt = $${idx * 2 + 2})`,
      ).join(' OR ');
      let rows: Record<string, unknown>[] = [];
      try {
        const result = await client.query(
          `SELECT run_id, run_attempt, job_id, name, status, conclusion, created_at,
                   started_at, completed_at, html_url, queue_duration_seconds,
                   runtime_seconds, total_duration_seconds, duration_seconds
            FROM workflow_jobs
            WHERE ${clauses}
            ORDER BY run_id, run_attempt, started_at ASC`,
          chunk.flatMap((key) => [key.runId, key.runAttempt]),
        );
        rows = result.rows as Record<string, unknown>[];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('does not exist')) {
          rows = [];
        } else {
          throw error;
        }
      }
      jobRows.push(...rows);
    }

    const jobsByAttempt = new Map<string, Job[]>();
    for (const row of jobRows) {
      const key = `${Number(row.run_id)}:${Number(row.run_attempt)}`;
      if (!jobsByAttempt.has(key)) jobsByAttempt.set(key, []);
      jobsByAttempt.get(key)!.push(mapAttemptJobRow(row));
    }

    const runs = attemptRows.map((row) => {
      const run = mapAttemptRunRow(row);
      run.jobs = jobsByAttempt.get(`${run.id}:${run.runAttempt ?? 1}`) ?? [];
      return run;
    });

    if (dateFilter.includeSteps) {
      await fetchAttemptStepsAndAttach(runs);
    }

    return runs;
  } finally {
    client.release();
  }
}

function selectFiles(files: string[], options: FetchRunsOptions): string[] {
  const { days = 7, startDate, endDate, now = new Date() } = options;

  if (startDate && endDate) {
    return files.filter((file) => {
      const date = file.replace(/\.json$/, '');
      return date >= startDate && date <= endDate;
    });
  }

  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return files.filter((file) => file.replace(/\.json$/, '') >= cutoffDate);
}

async function fetchRunsFromFiles(owner: string, repo: string, files: string[]): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  const allRuns: Run[] = [];
  for (const file of files) {
    const date = file.replace('.json', '');
    const runs = await fetchRunsFromDb(repoId, { startDate: date, endDate: date });
    allRuns.push(...runs);
  }

  return allRuns;
}

export async function fetchRuns(owner: string, repo: string, options: FetchRunsOptions = {}): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  if (options.startDate && options.endDate) {
    return fetchRunsFromDb(repoId, { startDate: options.startDate, endDate: options.endDate, includeSteps: options.includeSteps });
  }

  const { days = 7, now = new Date() } = options;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return fetchRunsFromDb(repoId, { startDate: cutoffDate, endDate: undefined, includeSteps: options.includeSteps });
}

export async function fetchRunsFromIndex(
  owner: string,
  repo: string,
  repoIndex: Index,
  options: FetchRunsOptions = {}
): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  if (options.startDate && options.endDate) {
    return fetchRunsFromDb(repoId, { startDate: options.startDate, endDate: options.endDate, includeSteps: options.includeSteps });
  }

  const dates = selectFiles(repoIndex.files, options);
  if (dates.length === 0) return [];

  const firstDate = dates[dates.length - 1].replace('.json', '');
  const lastDate = dates[0].replace('.json', '');

  return fetchRunsFromDb(repoId, { startDate: firstDate, endDate: lastDate, includeSteps: options.includeSteps });
}

export async function fetchLatestRuns(owner: string, repo: string, maxFiles = 7): Promise<Run[]> {
  const repoId = await getRepoId(owner, repo);

  return fetchRunsFromDb(repoId, { limit: maxFiles * 20 });
}

export async function fetchLatestRunsFromIndex(
  owner: string,
  repo: string,
  repoIndex: Index,
  maxFiles = 7
): Promise<Run[]> {
  const latestFiles = [...repoIndex.files]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, maxFiles);

  return fetchRunsFromFiles(owner, repo, latestFiles);
}
