// Shared TypeScript types for split architecture
// Used by both ETL (data branch) and Frontend (main branch)

export interface Index {
  version: number;
  latest: string;
  files: string[];
  retention_days: number;
  last_updated: string;
  history_complete?: boolean;
  backfill_cursor?: string;
}

export interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

export interface PullRequestRef {
  number: number;
}

export type GitHubApiPayload = Record<string, unknown>;

export interface PullRequestUser {
  login: string;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  state: string;
  created_at: string;
  merged_at: string | null;
  html_url: string;
  user?: PullRequestUser;
}

export interface Run {
  id: number;
  runAttempt?: number;
  name: string;
  head_branch: string;
  head_sha?: string;
  status: string;
  conclusion: string;
  event?: string;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  queueDurationInSeconds?: number;
  runtimeInSeconds?: number;
  workflowFile?: string;
  workflowRef?: string;
  workflowPath?: string;
  workflowParseStatus?: 'ok' | 'ref_unavailable' | 'file_unavailable';
  workflowMatchKind?: 'exact_ref' | 'glob_ref' | 'file_only';
  stepPolicyHash?: string;
  tracked?: boolean;
  pull_requests?: PullRequestRef[];
  jobs?: Job[];
  githubPayload?: GitHubApiPayload;
}

export interface Step {
  name: string;
  status: string;
  conclusion: string;
  started_at?: string;
  completed_at?: string;
  number: number;
  duration_seconds?: number;
}

export interface Job {
  id: number;
  runAttempt?: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
  runtimeInSeconds?: number;
  totalDurationInSeconds?: number;
  labels?: string[];
  runner_id?: number;
  runner_name?: string;
  runner_group_id?: number;
  runner_group_name?: string;
  resource_model?: string;
  resource_count?: number;
  githubPayload?: GitHubApiPayload;
  steps?: Step[];
}

export interface PullRequestMetricsSummary {
  number: number;
  title: string;
  branch: string;
  author: string;
  state: string;
  html_url: string;
  created_at: string;
  ci_started_at?: string;
  ci_completed_at?: string;
  merged_at?: string;
  partialCiHistory: boolean;
  timeToCiStartInSeconds?: number;
  ciDurationInSeconds?: number;
  timeToMergeInSeconds?: number;
  mergeLeadTimeInSeconds?: number;
  workflowCount: number;
  successfulWorkflowCount: number;
  conclusion: string;
  currentCiConclusion?: string;
  attemptSuccessRate?: number;
}

export interface PullRequestMetricsDetail {
  repo: string;
  generated_at: string;
  pr: PullRequestMetricsSummary & {
    workflows: Run[];
  };
}

export type PullRequestDetailFile = PullRequestMetricsDetail;

export interface PullRequestIndexFile {
  repo: string;
  generated_at: string;
  prs: PullRequestMetricsSummary[];
  partialPrResolution?: boolean;
  missingPrArtifact?: boolean;
  resolvedPrShaCount?: number;
  unresolvedPrShaCount?: number;
  skippedPrShaCount?: number;
}

export type OverviewMetricKey = 'prE2EP90Minutes' | 'ciE2EP90Minutes' | 'reviewP90Minutes' | 'ciE2ESlaRate';

export interface DateRange {
  start: Date;
  end: Date;
}

export interface RepoOverviewRow {
  repoKey: string;
  totalPrs: number;
  sampleCount: number;
  prE2EP90Minutes: number | null;
  ciE2EP90Minutes: number | null;
  reviewP90Minutes: number | null;
  ciE2ESlaRate: number | null;
}

export interface DailyTrendPoint {
  date: string;
  label: string;
  sampleCount: number;
  prE2EP90Minutes: number | null;
  ciE2EP90Minutes: number | null;
  reviewP90Minutes: number | null;
  ciE2ESlaRate: number | null;
}

export interface TestCaseStats {
  total_test_cases: number;
  ascend_test_cases: number;
  nvidia_test_cases: number;
  window_start: string;
  window_end: string;
  generated_at: string;
}
