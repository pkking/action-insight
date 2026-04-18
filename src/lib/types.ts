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
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  event?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
  pull_requests?: PullRequestRef[];
  jobs?: Job[];
}

export interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  queueDurationInSeconds: number;
  durationInSeconds: number;
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
}
