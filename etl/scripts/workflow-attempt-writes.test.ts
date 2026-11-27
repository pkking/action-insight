import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { writeWorkflowAttemptsToClient } from './workflow-attempt-writes';
import type { WorkflowAttemptRow } from './workflow-attempts';

/**
 * Focused regression tests for workflow_attempts queue handling and evidence.
 * The fake client interprets the emitted upsert SQL against an in-memory store.
 */

type Row = Record<string, unknown>;

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** Evaluate one `SET target=expression` right-hand side. */
function evaluateAssignment(
  expr: string,
  excluded: Row,
  existing: Row | undefined,
): unknown {
  const e = expr.trim();
  if (e.startsWith('CASE WHEN excluded.run_attempt > 1 THEN NULL WHEN')) {
    if (Number(excluded.run_attempt) > 1) return null;
    return shouldPreserveQueue(e, excluded, existing) ? existing?.queue_duration_seconds : excluded.queue_duration_seconds;
  }
  if (e.startsWith('CASE WHEN excluded.run_attempt = 1')) {
    if (!shouldPreserveQueue(e, excluded, existing)) return excluded.timing_evidence;
    // Mirrors `workflow_attempts.timing_evidence || COALESCE(excluded.timing_evidence, '{}')`
    // followed by restoring the verified queue value.
    const prior = (existing?.timing_evidence ?? { version: 1 }) as Row;
    const incoming = (excluded.timing_evidence ?? {}) as Row;
    return { ...prior, ...incoming, queue_duration_seconds: prior.queue_duration_seconds };
  }
  const attemptCase = e.match(/^CASE WHEN excluded\.run_attempt > 1 THEN NULL ELSE (.*) END$/is);
  if (attemptCase) return Number(excluded.run_attempt) > 1 ? null : evaluateAssignment(attemptCase[1], excluded, existing);
  const coalesce = e.match(/^COALESCE\((.*)\)$/is);
  if (coalesce) {
    for (const arg of splitTopLevel(coalesce[1])) {
      const value = evaluateAssignment(arg, excluded, existing);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }
  const ref = e.match(/^(excluded|workflow_attempts)\.(.+)$/);
  if (!ref) throw new Error(`unsupported SET expression: ${e}`);
  const source = ref[1] === 'excluded' ? excluded : existing;
  return source?.[ref[2].trim()] ?? null;
}

function shouldPreserveQueue(sql: string, incoming: Row, existing: Row | undefined): boolean {
  for (const clause of [
    'excluded.run_attempt = 1', 'excluded.queue_duration_seconds IS NULL',
    'excluded.jobs_fetched_at IS NULL',
    'excluded.created_at IS NOT DISTINCT FROM workflow_attempts.created_at',
    "workflow_attempts.timing_evidence->'version' = '1'::jsonb",
    "jsonb_typeof(workflow_attempts.timing_evidence->'queue_duration_seconds') = 'number'",
    'workflow_attempts.queue_duration_seconds IS NOT NULL',
    "excluded.timing_evidence->'version' = '1'::jsonb",
    "excluded.timing_evidence->'queue_duration_seconds' IS NULL",
  ]) expect(sql).toContain(clause);
  const previous = existing?.timing_evidence as Row | null;
  const next = incoming.timing_evidence as Row | null;
  return Number(incoming.run_attempt) === 1 && incoming.queue_duration_seconds == null &&
    incoming.jobs_fetched_at == null && incoming.created_at === existing?.created_at &&
    previous?.version === 1 && typeof previous.queue_duration_seconds === 'number' &&
    existing?.queue_duration_seconds != null && (next == null || next.version === 1) &&
    next?.queue_duration_seconds == null;
}

/** Apply the workflow_attempts upsert against an in-memory store. */
function applyAttemptUpsert(
  store: Map<string, Row>,
  sql: string,
  params: unknown[],
): void {
  const columns = sql
    .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const setClause = sql.slice(sql.indexOf('DO UPDATE SET') + 'DO UPDATE SET'.length);
  const assignments = splitTopLevel(setClause).map((a) => {
    const eq = a.indexOf('=');
    return { target: a.slice(0, eq).trim(), expr: a.slice(eq + 1) };
  });
  const row: Row = {};
  columns.forEach((col, i) => {
    row[col] = col === 'timing_evidence' && params[i] != null
      ? JSON.parse(params[i] as string) : params[i] ?? null;
  });
  const key = `${row.run_id}:${row.run_attempt}`;
  const existing = store.get(key);
  if (!existing) {
    store.set(key, row);
    return;
  }
  const original = { ...existing };
  for (const { target, expr } of assignments) {
    existing[target] = evaluateAssignment(expr, row, original);
  }
}

function createFakeClient(store: Map<string, Row>, attemptEvidence = false, jobEvidence = false): PoolClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM pg_attribute')) {
      return { rows: [{ attempt_evidence: attemptEvidence, job_evidence: jobEvidence }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO workflow_attempts')) {
      applyAttemptUpsert(store, sql, params ?? []);
    }
    // BEGIN/COMMIT and workflow_jobs/workflow_steps writes are no-ops here.
    return { rows: [], rowCount: 0 };
  });
  return { query } as unknown as PoolClient;
}

function attempt(overrides: Partial<WorkflowAttemptRow> = {}): WorkflowAttemptRow {
  return {
    run_id: 100,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-21T00:00:00Z',
    run_started_at: '2026-09-21T00:02:00Z',
    completed_at: '2026-09-21T00:10:00Z',
    updated_at: '2026-09-21T00:10:00Z',
    queue_duration_seconds: 120,
    runtime_seconds: 480,
    total_duration_seconds: 600,
    tracked: true,
    workflow_file: 'ci.yml',
    workflow_ref: 'main',
    workflow_path: '.github/workflows/ci.yml@main',
    workflow_parse_status: 'ok',
    match_kind: 'exact_ref',
    jobs_fetched_at: '2026-09-21T00:11:00Z',
    steps_eligibility_checked_at: null,
    steps_collected_at: null,
    step_policy_hash: null,
    pr_numbers: [],
    jobs: [],
    ...overrides,
  };
}

describe('writeWorkflowAttemptsToClient queue_duration_seconds upsert', () => {
  it('does not keep an unverifiable stored queue on an old schema', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store);

    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: 120 })]);
    // Cache-fresh dehydration: same attempt re-persisted without hydrated jobs.
    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: null })]);

    const stored = store.get('100:1');
    expect(stored).toBeDefined();
    expect(stored?.queue_duration_seconds).toBeNull();
  });

  it('inserts NULL queue_duration_seconds for a brand-new attempt', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store);

    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: null })]);

    const stored = store.get('100:1');
    expect(stored).toBeDefined();
    expect(stored?.queue_duration_seconds).toBeNull();
  });

  it('overwrites queue_duration_seconds when the re-upsert carries a non-NULL value', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store);

    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: 120 })]);
    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: 300 })]);

    const stored = store.get('100:1');
    expect(stored).toBeDefined();
    expect(stored?.queue_duration_seconds).toBe(300);
  });
});

describe('timing evidence writes', () => {
  const marked = { version: 1 as const, queue_duration_seconds: 120, runtime_seconds: 480 };
  const withEvidence = (overrides: Partial<WorkflowAttemptRow>, evidence: unknown) =>
    Object.assign(attempt(overrides), { timing_evidence: evidence });

  it('serializes optional evidence for attempts and jobs when columns exist', async () => {
    const client = createFakeClient(new Map(), true, true);
    const jobEvidence = { version: 1, runtime_seconds: 45, completion_source: 'job' };
    const input = withEvidence({}, marked);
    input.jobs = [{ run_id: 100, run_attempt: 1, job_id: 5, timing_evidence: jobEvidence } as unknown as WorkflowAttemptRow['jobs'][number]];
    await writeWorkflowAttemptsToClient(client, [input]);
    const calls = vi.mocked(client.query).mock.calls as unknown as [string, unknown[]][];
    for (const [table, evidence] of [['workflow_attempts', marked], ['workflow_jobs', jobEvidence]] as const) {
      const [sql, params] = calls.find(([text]) => text.includes(`INSERT INTO ${table} (`))!;
      expect(sql).toContain('timing_evidence');
      expect(sql).toContain('timing_evidence=');
      expect(params.at(-1)).toBe(JSON.stringify(evidence));
    }
  });

  it('omits evidence independently for tables on an old or partially migrated schema', async () => {
    for (const [attemptColumn, jobColumn] of [[false, false], [true, false], [false, true]]) {
      const client = createFakeClient(new Map(), attemptColumn, jobColumn);
      const input = withEvidence({}, marked);
      input.jobs = [{ run_id: 100, run_attempt: 1, job_id: 5, timing_evidence: marked } as unknown as WorkflowAttemptRow['jobs'][number]];
      await writeWorkflowAttemptsToClient(client, [input]);
      const calls = vi.mocked(client.query).mock.calls as unknown as [string, unknown[]][];
      for (const [table, present] of [['workflow_attempts', attemptColumn], ['workflow_jobs', jobColumn]] as const) {
        const [sql, params] = calls.find(([text]) => text.includes(`INSERT INTO ${table} (`))!;
        expect(sql.includes('timing_evidence')).toBe(present);
        expect(params.includes(JSON.stringify(marked))).toBe(present);
      }
    }
  });

  it('preserves only verified queue evidence on unchanged dehydrated input', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store, true);
    await writeWorkflowAttemptsToClient(client, [withEvidence({}, marked)]);
    await writeWorkflowAttemptsToClient(client, [withEvidence({ queue_duration_seconds: null, jobs_fetched_at: null }, { version: 1, runtime_seconds: 7 })]);
    expect(store.get('100:1')?.queue_duration_seconds).toBe(120);
    expect(store.get('100:1')?.timing_evidence).toEqual({ version: 1, queue_duration_seconds: 120, runtime_seconds: 7 });
  });

  it('keeps other verified evidence fields when preserving dehydrated queue input', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store, true);
    const full = {
      version: 1 as const,
      queue_duration_seconds: 60,
      total_duration_seconds: 43260,
      runtime_seconds: 43200,
      trigger_at: '2026-10-01T00:00:00Z',
      completed_at: '2026-10-01T12:01:00Z',
      completion_source: 'github_run.completed_at',
    };
    await writeWorkflowAttemptsToClient(client, [withEvidence({ queue_duration_seconds: full.queue_duration_seconds }, full)]);
    // Run-only rewrite: fresh runtime evidence without jobs (queue unknown).
    await writeWorkflowAttemptsToClient(client, [withEvidence({ queue_duration_seconds: null, jobs_fetched_at: null }, { version: 1, runtime_seconds: 43000 })]);
    expect(store.get('100:1')?.timing_evidence).toEqual({ ...full, runtime_seconds: 43000 });
    expect(store.get('100:1')?.queue_duration_seconds).toBe(60);
  });

  it.each([
    ['jobs fetched', {}, { jobs_fetched_at: '2026-09-21T00:11:00Z' }, marked],
    ['created changed', {}, { created_at: '2026-09-22T00:00:00Z' }, marked],
    ['unmarked previous', {}, {}, null],
    ['different previous version', {}, {}, { ...marked, version: 2 }],
    ['missing previous queue evidence', {}, {}, { version: 1 }],
    ['rerun', { run_attempt: 2 }, { run_attempt: 2 }, marked],
  ])('does not preserve queue for %s', async (_name, initial, incoming, evidence) => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store, true);
    await writeWorkflowAttemptsToClient(client, [withEvidence(initial, evidence)]);
    await writeWorkflowAttemptsToClient(client, [withEvidence({ jobs_fetched_at: null, ...incoming, queue_duration_seconds: null }, { version: 1, runtime_seconds: 7 })]);
    const stored = store.get(`100:${'run_attempt' in initial ? initial.run_attempt : 1}`);
    expect(stored?.queue_duration_seconds).toBeNull();
    expect(stored?.timing_evidence).toEqual({ version: 1, runtime_seconds: 7 });
  });
});
