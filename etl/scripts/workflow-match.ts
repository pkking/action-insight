/**
 * Tracked workflow matching and step-eligibility threshold policy.
 *
 * See ADR-005 and CONTEXT.md. A run belongs to at most one Tracked Workflow,
 * matched by workflow file basename and optional workflow ref. When multiple
 * rules can match the same run, precedence is exact ref, then glob ref, then
 * file-only. Multiple same-precedence matches are invalid configuration.
 *
 * The Step Analysis Threshold default is 600 seconds; override precedence is
 * exact-ref workflow, glob-ref workflow, file-only workflow, repository, then
 * defaults. A stable step policy hash records the matched rule + threshold so
 * Step Eligibility Backfill can detect when an attempt needs re-evaluation.
 */

import { createHash } from 'node:crypto';

import { isGlobRef, matchGlobRef, type ParsedWorkflowPath } from './workflow-path.ts';
import type { RepoConfigEntry, ReposConfig, WorkflowRule } from './repos-config.ts';

/** Default step analysis threshold (seconds) per CONTEXT.md. */
export const DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS = 600;

export type WorkflowMatchKind = 'exact_ref' | 'glob_ref' | 'file_only';

export interface WorkflowMatchResult {
  repo: string;
  /** The rule that matched, if any. */
  rule?: WorkflowRule;
  kind?: WorkflowMatchKind;
  /** Effective step threshold in seconds for this attempt. */
  stepThresholdSeconds: number;
  /** Whether the run is a Tracked Workflow. */
  tracked: boolean;
  /** Reason the run is not tracked, when tracked is false. */
  reason?: 'file_unavailable' | 'ref_unavailable_no_match' | 'no_match' | 'ambiguous';
}

/**
 * Resolve the full match result for a run against a repo's configuration.
 *
 * Precedence: exact ref > glob ref > file-only. File-only rules match any ref,
 * including Workflow Ref Unavailable runs; ref-specific rules cannot match a
 * ref-unavailable run. Same-precedence overlap is ambiguous configuration.
 */
export function resolveWorkflowMatch(
  config: ReposConfig,
  repoConfig: RepoConfigEntry,
  parsed: ParsedWorkflowPath,
): WorkflowMatchResult {
  const repo = repoConfig.repo;

  if (parsed.status === 'file_unavailable' || !parsed.file) {
    return { repo, stepThresholdSeconds: DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS, tracked: false, reason: 'file_unavailable' };
  }

  const file = parsed.file;
  const ref = parsed.status === 'ok' ? parsed.ref : undefined;

  const exactRefMatches: WorkflowRule[] = [];
  const globRefMatches: WorkflowRule[] = [];
  const fileOnlyMatches: WorkflowRule[] = [];
  let fileConfigured = false;

  for (const rule of repoConfig.workflows) {
    if (rule.file !== file) continue;
    fileConfigured = true;

    if (rule.ref) {
      // ref-specific rules cannot match a Workflow Ref Unavailable run
      if (ref === undefined) continue;
      if (isGlobRef(rule.ref)) {
        if (matchGlobRef(rule.ref, ref)) globRefMatches.push(rule);
      } else if (rule.ref === ref) {
        exactRefMatches.push(rule);
      }
    } else {
      fileOnlyMatches.push(rule); // file-only matches any ref
    }
  }

  let rule: WorkflowRule | undefined;
  let kind: WorkflowMatchKind | undefined;
  let ambiguous = false;
  if (exactRefMatches.length === 1) { rule = exactRefMatches[0]; kind = 'exact_ref'; }
  else if (exactRefMatches.length > 1) { ambiguous = true; }
  else if (globRefMatches.length === 1) { rule = globRefMatches[0]; kind = 'glob_ref'; }
  else if (globRefMatches.length > 1) { ambiguous = true; }
  else if (fileOnlyMatches.length === 1) { rule = fileOnlyMatches[0]; kind = 'file_only'; }
  else if (fileOnlyMatches.length > 1) { ambiguous = true; }

  if (!rule || !kind) {
    const reason: WorkflowMatchResult['reason'] = ambiguous
      ? 'ambiguous'
      : fileConfigured && ref === undefined
        ? 'ref_unavailable_no_match'
        : 'no_match';
    return { repo, stepThresholdSeconds: DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS, tracked: false, reason };
  }

  const stepThresholdSeconds =
    rule.stepsMinWorkflowDurationSeconds
    ?? repoConfig.stepsMinWorkflowDurationSeconds
    ?? config.defaults?.stepsMinWorkflowDurationSeconds
    ?? DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS;

  return { repo, rule, kind, stepThresholdSeconds, tracked: true };
}

/** Step eligibility policy version; bump when the eligibility rule semantics change. */
export const STEP_POLICY_VERSION = 1;

/**
 * Stable hash of the step-eligibility policy for a workflow attempt: matched
 * workflow file, matched ref rule, step threshold, and policy version. Used to
 * detect when an attempt's eligibility needs re-evaluation after a policy change.
 */
export function stepPolicyHash(match: WorkflowMatchResult): string {
  const payload = [
    STEP_POLICY_VERSION,
    match.tracked ? match.rule?.file ?? '' : '',
    match.tracked ? match.rule?.ref ?? '' : '',
    match.stepThresholdSeconds,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
