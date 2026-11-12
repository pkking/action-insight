import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { writeWorkflowAttemptsToClient } from './workflow-attempt-writes';
import type { WorkflowAttemptRow } from './workflow-attempts';

/**
 * Focused regression tests for the workflow_attempts upsert
 * queue_duration_seconds handling (ADR-038 constraint 1).
 *
 * The fake client below interprets the actual `INSERT ... ON CONFLICT ... DO
 * UPDATE SET` SQL emitted by writeWorkflowAttemptsToClient, so a regression
 * that reverts `queue_duration_seconds=COALESCE(...)` back to a direct
 * `excluded.` assignment makes these tests fail.
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
    row[col] = params[i] ?? null;
  });
  const key = `${row.run_id}:${row.run_attempt}`;
  const existing = store.get(key);
  if (!existing) {
    store.set(key, row);
    return;
  }
  for (const { target, expr } of assignments) {
    existing[target] = evaluateAssignment(expr, row, existing);
  }
}

function createFakeClient(store: Map<string, Row>): PoolClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
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
  it('keeps the stored queue_duration_seconds when a re-upsert carries NULL', async () => {
    const store = new Map<string, Row>();
    const client = createFakeClient(store);

    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: 120 })]);
    // Cache-fresh dehydration: same attempt re-persisted without hydrated jobs.
    await writeWorkflowAttemptsToClient(client, [attempt({ queue_duration_seconds: null })]);

    const stored = store.get('100:1');
    expect(stored).toBeDefined();
    expect(stored?.queue_duration_seconds).toBe(120);
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
