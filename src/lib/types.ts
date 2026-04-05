// Shared TypeScript types for split architecture
// Used by both ETL (data branch) and Frontend (main branch)

export interface Index {
  version: number;
  repos: Record<string, RepoIndex>;
  last_updated: string;
}

export interface RepoIndex {
  latest: string;
  files: string[];
  retention_days: number;
}

export interface DayData {
  date: string;
  repo: string;
  runs: Run[];
}

export interface Run {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  durationInSeconds: number;
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
