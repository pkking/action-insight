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
 * Select the rule that matches a parsed workflow path for a repo.
 *
 * Precedence: exact ref > glob ref > file-only. File-only rules match any ref,
 * including Workflow Ref Unavailable runs. Glob rules require a concrete ref.
 * Two rules at the same precedence matching the same run is ambiguous and
 * rejected (returns kind undefined with reason 'ambiguous').
 */
export function matchWorkflowRule(
  repoConfig: RepoConfigEntry,
  parsed: ParsedWorkflowPath,
): Pick<WorkflowMatchResult, 'rule' | 'kind' | 'reason'> {
  if (parsed.status === 'file_unavailable' || !parsed.file) {
    return { reason: 'file_unavailable' };
  }

  const file = parsed.file;
  const ref = parsed.status === 'ok' ? parsed.ref : undefined;

  const exactRefMatches: WorkflowRule[] = [];
  const globRefMatches: WorkflowRule[] = [];
  const fileOnlyMatches: WorkflowRule[] = [];

  for (const rule of repoConfig.workflows) {
    if (rule.file !== file) continue;

    if (rule.ref) {
      if (ref === undefined) continue; // ref-specific rule cannot match a ref-unavailable run
      if (isGlobRef(rule.ref)) {
        if (matchGlobRef(rule.ref, ref)) globRefMatches.push(rule);
      } else if (rule.ref === ref) {
        exactRefMatches.push(rule);
      }
    } else {
      fileOnlyMatches.push(rule); // file-only matches any ref
    }
  }

  if (exactRefMatches.length === 1) return { rule: exactRefMatches[0], kind: 'exact_ref' };
  if (exactRefMatches.length > 1) return { reason: 'ambiguous' };

  if (globRefMatches.length === 1) return { rule: globRefMatches[0], kind: 'glob_ref' };
  if (globRefMatches.length > 1) return { reason: 'ambiguous' };

  if (fileOnlyMatches.length === 1) return { rule: fileOnlyMatches[0], kind: 'file_only' };
  if (fileOnlyMatches.length > 1) return { reason: 'ambiguous' };

  if (fileOnlyMatches.length === 0 && ref === undefined && (exactRefMatches.length || globRefMatches.length) === 0) {
    return { reason: 'ref_unavailable_no_match' };
  }

  return { reason: 'no_match' };
}

/**
 * Compute the effective step threshold for a matched attempt.
 * Precedence: exact-ref workflow > glob-ref workflow > file-only workflow > repo > defaults.
 */
export function effectiveStepThreshold(
  config: ReposConfig,
  repoConfig: RepoConfigEntry,
  match: Pick<WorkflowMatchResult, 'rule' | 'kind'>,
): number {
  if (match.rule?.stepsMinWorkflowDurationSeconds !== undefined) {
    return match.rule.stepsMinWorkflowDurationSeconds;
  }
  // Same-file rules without a threshold at lower precedence could still carry one;
  // the matched rule already won precedence, so its threshold (if any) is authoritative.
  if (repoConfig.stepsMinWorkflowDurationSeconds !== undefined) {
    return repoConfig.stepsMinWorkflowDurationSeconds;
  }
  if (config.defaults?.stepsMinWorkflowDurationSeconds !== undefined) {
    return config.defaults.stepsMinWorkflowDurationSeconds;
  }
  return DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS;
}

/**
 * Resolve the full match result for a run against a repo's configuration.
 */
export function resolveWorkflowMatch(
  config: ReposConfig,
  repoConfig: RepoConfigEntry,
  parsed: ParsedWorkflowPath,
): WorkflowMatchResult {
  const { rule, kind, reason } = matchWorkflowRule(repoConfig, parsed);
  if (!rule || !kind) {
    return {
      repo: repoConfig.repo,
      stepThresholdSeconds: DEFAULT_STEP_ANALYSIS_THRESHOLD_SECONDS,
      tracked: false,
      reason,
    };
  }
  return {
    repo: repoConfig.repo,
    rule,
    kind,
    stepThresholdSeconds: effectiveStepThreshold(config, repoConfig, { rule, kind }),
    tracked: true,
  };
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
