/**
 * Parse a GitHub Actions workflow run `path` into a workflow file basename and
 * optional workflow ref. See ADR-005 and CONTEXT.md (Workflow File Path).
 *
 * GitHub reports workflow paths as `.github/workflows/ci.yml@main` where the
 * segment before `@` is the workflow file path and the segment after `@` is the
 * workflow ref. Workflow file basename is the durable tracked-workflow key; the
 * ref is optional and may be absent (Workflow Ref Unavailable).
 *
 * This module never guesses the file from a workflow name. When metadata lacks
 * a usable path it returns an explicit `file_unavailable` status so callers can
 * keep Workflow Run Metadata without treating the run as a Tracked Workflow.
 */

export type WorkflowParseStatus =
  | 'ok'
  /** GitHub reported a workflow file but no usable ref (file-only matching still possible). */
  | 'ref_unavailable'
  /** GitHub metadata does not include a usable workflow file path. */
  | 'file_unavailable';

export interface ParsedWorkflowPath {
  /** Workflow file basename such as `ci.yml`. Undefined when status is `file_unavailable`. */
  file?: string;
  /** Workflow ref such as `main` or `release/*`. Undefined when not reported. */
  ref?: string;
  status: WorkflowParseStatus;
}

const WORKFLOW_FILE_BASENAME_PATTERN = /^[^/\\]+\.ya?ml$/;

/**
 * Parse a raw workflow run `path` value (or undefined) into a structured result.
 *
 * Examples:
 *   `.github/workflows/ci.yml@main`      -> { file: 'ci.yml', ref: 'main', status: 'ok' }
 *   `.github/workflows/ci.yml`           -> { file: 'ci.yml', status: 'ref_unavailable' }
 *   `.github/workflows/sub/ci.yml@main`  -> { file: undefined, status: 'file_unavailable' } (nested path not a basename)
 *   undefined / '' / 'not a path'        -> { status: 'file_unavailable' }
 */
export function parseWorkflowPath(rawPath: unknown): ParsedWorkflowPath {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { status: 'file_unavailable' };
  }

  const atIdx = rawPath.lastIndexOf('@');
  const filePath = atIdx === -1 ? rawPath : rawPath.slice(0, atIdx);
  const ref = atIdx === -1 ? undefined : rawPath.slice(atIdx + 1);

  const file = filePath.split('/').pop() ?? '';
  if (!WORKFLOW_FILE_BASENAME_PATTERN.test(file)) {
    return { status: 'file_unavailable' };
  }

  if (atIdx === -1 || ref === undefined || ref.length === 0) {
    return { file, status: 'ref_unavailable' };
  }

  return { file, ref, status: 'ok' };
}

/**
 * Whether a ref string is a glob (contains `*`) or an exact ref.
 * Workflow ref matching supports exact refs and simple glob patterns; regex is
 * not supported (CONTEXT.md).
 */
export function isGlobRef(ref: string): boolean {
  return ref.includes('*');
}

/**
 * Match a glob ref pattern against a concrete ref. Supports `*` as a wildcard
 * within a single path segment (e.g. `release/*` matches `release/1`, not
 * `release/a/b`). Anchored: the whole ref must match the pattern.
 */
export function matchGlobRef(pattern: string, ref: string): boolean {
  // ponytail: glob with single-segment `*` wildcard. Escaping regex specials in
  // the literal parts keeps this safe for the validated ref charset.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(ref);
}
