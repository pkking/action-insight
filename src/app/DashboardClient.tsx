'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  AlignLeft,
  Calendar as CalendarIcon,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
  Info,
  LayoutList,
  MessageSquare,
  Share2,
  XCircle,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';

import { buildDailyTrend, buildRepoOverviewRows, createDateRange, filterByDateRange } from '@/lib/overview-metrics';
import type { RepoOption } from '@/lib/server-homepage-data';
import type {
  DailyTrendPoint,
  PullRequestDetailFile,
  PullRequestIndexFile,
  RepoOverviewRow,
  Run,
} from '@/lib/types';

async function callApi<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'API request failed');
  }

  return result.data;
}

type JobSortField = 'queue' | 'duration' | 'name';
type WorkflowSortField = 'date' | 'duration' | 'name';
type WorkflowSortOrder = 'asc' | 'desc' | 'none';
type PrLifecycleViewMode = 'pr' | 'workflow' | 'job';
type WorkflowTimingData = {
  id: number;
  name: string;
  queueTimeSeconds: number | undefined;
  e2eTimeSeconds: number;
  conclusion: string;
  created_at: string;
};
type JobTimingData = {
  id: number;
  name: string;
  workflowName: string;
  workflowId: number;
  queueTimeSeconds: number;
  e2eTimeSeconds: number;
  conclusion: string;
  created_at: string;
  html_url: string;
};
type MetricKey = 'prE2EP90Minutes' | 'ciE2EP90Minutes' | 'reviewP90Minutes' | 'ciE2ESlaRate';
type DashboardQueryState = {
  days: number;
  startDate: string;
  endDate: string;
  useCustomRange: boolean;
  filterName: string;
  repoKey: string;
};

type DashboardClientProps = {
  initialFailedRepoKeys: string[];
  initialRepoIndexesByKey: Record<string, PullRequestIndexFile>;
  initialRepoOptions: RepoOption[];
  initialSearchParams?: Record<string, string | string[] | undefined>;
};

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

const METRIC_OPTIONS: Array<{
  key: MetricKey;
  label: string;
  stroke: string;
  yAxisId: 'minutes' | 'rate';
}> = [
  { key: 'prE2EP90Minutes', label: 'PR E2E P90', stroke: '#2563eb', yAxisId: 'minutes' },
  { key: 'ciE2EP90Minutes', label: 'CI E2E P90', stroke: '#0f766e', yAxisId: 'minutes' },
  { key: 'reviewP90Minutes', label: 'PR Review P90', stroke: '#ea580c', yAxisId: 'minutes' },
  { key: 'ciE2ESlaRate', label: 'CI E2E SLA', stroke: '#7c3aed', yAxisId: 'rate' },
];

const LOW_SAMPLE_THRESHOLD = 5;

function formatDurationMinutes(seconds?: number) {
  if (seconds === undefined) {
    return 'N/A';
  }

  return `${Math.round(seconds / 60)}m`;
}

function formatMetricMinutes(value: number | null) {
  return value === null ? 'Insufficient data' : `${value}m`;
}

function formatRate(value: number | null) {
  return value === null ? 'Insufficient data' : `${value}%`;
}

function parseDashboardQuery(params: Pick<URLSearchParams, 'get'>): DashboardQueryState {
  const daysParam = params.get('days');
  const parsedDays = daysParam ? parseInt(daysParam, 10) : 7;

  return {
    days: Number.isNaN(parsedDays) ? 7 : parsedDays,
    startDate: params.get('startDate') || '',
    endDate: params.get('endDate') || '',
    useCustomRange: params.get('useCustomRange') === 'true',
    filterName: params.get('filterName') || '',
    repoKey: params.get('repo') || '',
  };
}

function searchParamsToUrlSearchParams(input?: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();

  if (!input) {
    return params;
  }

  for (const [key, rawValue] of Object.entries(input)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        params.append(key, value);
      }
      continue;
    }

    if (rawValue !== undefined) {
      params.set(key, rawValue);
    }
  }

  return params;
}

function getLatestPrDate(repoIndexesByKey: Record<string, PullRequestIndexFile>): Date | undefined {
  let latestCreatedAt = '';

  for (const index of Object.values(repoIndexesByKey)) {
    const latestInRepo = index.prs[0]?.created_at;
    if (latestInRepo && latestInRepo > latestCreatedAt) {
      latestCreatedAt = latestInRepo;
    }
  }

  return latestCreatedAt ? new Date(latestCreatedAt) : undefined;
}

function sortWorkflows(workflows: Run[], field: WorkflowSortField, order: WorkflowSortOrder): Run[] {
  const result = [...workflows];
  if (order === 'none') {
    return result;
  }

  result.sort((left, right) => {
    let comparison = 0;

    if (field === 'date') comparison = left.created_at.localeCompare(right.created_at);
    else if (field === 'duration') comparison = left.durationInSeconds - right.durationInSeconds;
    else if (field === 'name') comparison = left.name.localeCompare(right.name);

    return order === 'asc' ? comparison : -comparison;
  });

  return result;
}

function calculateWorkflowQueueTime(run: Run): number | undefined {
  if (!run.jobs || run.jobs.length === 0) {
    return undefined;
  }

  let earliestStartedAt = Infinity;
  for (const job of run.jobs) {
    const startedMs = new Date(job.started_at || job.created_at || 0).getTime();
    if (startedMs < earliestStartedAt) {
      earliestStartedAt = startedMs;
    }
  }

  if (earliestStartedAt === Infinity) {
    return undefined;
  }

  const createdAtMs = new Date(run.created_at).getTime();
  const queueTimeMs = earliestStartedAt - createdAtMs;
  return Math.max(0, queueTimeMs / 1000);
}

function buildWorkflowTimingData(runs: Run[]): WorkflowTimingData[] {
  return runs.map((run) => ({
    id: run.id,
    name: run.name,
    queueTimeSeconds: calculateWorkflowQueueTime(run),
    e2eTimeSeconds: run.durationInSeconds,
    conclusion: run.conclusion,
    created_at: run.created_at,
  }));
}

function buildJobTimingData(runs: Run[]): JobTimingData[] {
  const jobs: JobTimingData[] = [];
  for (const run of runs) {
    if (!run.jobs || run.jobs.length === 0) continue;
    const runCreatedAtMs = new Date(run.created_at).getTime();
    for (const job of run.jobs) {
      const startedAtMs = new Date(job.started_at || job.created_at || 0).getTime();
      const completedAtMs = new Date(job.completed_at || job.started_at || 0).getTime();
      jobs.push({
        id: job.id,
        name: job.name,
        workflowName: run.name,
        workflowId: run.id,
        queueTimeSeconds: Math.max(0, (startedAtMs - runCreatedAtMs) / 1000),
        e2eTimeSeconds: Math.max(0, (completedAtMs - runCreatedAtMs) / 1000),
        conclusion: job.conclusion,
        created_at: run.created_at,
        html_url: job.html_url,
      });
    }
  }
  return jobs;
}

function StatusBadge({ conclusion }: { conclusion: string }) {
  if (conclusion === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200/50 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 dark:border-green-800/50 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle className="h-3.5 w-3.5" /> Success
      </span>
    );
  }

  if (conclusion === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
        <Info className="h-3.5 w-3.5" /> Skipped
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200/50 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-400">
      <XCircle className="h-3.5 w-3.5" /> {conclusion || 'Pending'}
    </span>
  );
}

function JobDetailsView({ run }: { run: Run }) {
  const [viewMode, setViewMode] = useState<'timeline' | 'table'>('timeline');
  const [sortField, setSortField] = useState<JobSortField>('duration');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const { minTime, maxTime } = useMemo(() => {
    if (!run.jobs || run.jobs.length === 0) {
      return { minTime: 0, maxTime: 1000 };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const job of run.jobs) {
      const start = new Date(job.created_at || job.started_at || 0).getTime();
      const end = new Date(job.completed_at || job.started_at || 0).getTime();
      if (start < min) min = start;
      if (end > max) max = end;
    }
    return { minTime: min, maxTime: max };
  }, [run.jobs]);
  const totalMs = Math.max(1000, maxTime - minTime);

  if (!run.jobs || run.jobs.length === 0) {
    return <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No jobs found for this workflow.</div>;
  }

  const sortedJobs = [...run.jobs].sort((a, b) => {
    let comparison = 0;
    if (sortField === 'name') comparison = a.name.localeCompare(b.name);
    if (sortField === 'duration') comparison = a.durationInSeconds - b.durationInSeconds;
    if (sortField === 'queue') comparison = a.queueDurationInSeconds - b.queueDurationInSeconds;
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const handleSort = (field: JobSortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortField(field);
    setSortOrder('desc');
  };

  return (
    <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">Job Execution Details</h4>
        <div className="flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
          <button
            type="button"
            onClick={() => setViewMode('timeline')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === 'timeline'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            <AlignLeft className="h-3.5 w-3.5" /> Timeline
          </button>
          <button
            type="button"
            onClick={() => setViewMode('table')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === 'table'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            <LayoutList className="h-3.5 w-3.5" /> Table
          </button>
        </div>
      </div>

      {viewMode === 'timeline' ? (
        <div className="space-y-3">
          <div className="mb-2 flex justify-between px-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
            <span>0m</span>
            <span>{formatDurationMinutes(totalMs / 1000)}</span>
          </div>
          {[...run.jobs]
            .sort((a, b) => new Date(a.created_at || a.started_at || 0).getTime() - new Date(b.created_at || b.started_at || 0).getTime())
            .map((job) => {
            const startMs = new Date(job.created_at || job.started_at || 0).getTime();
            const queueWidth = ((job.queueDurationInSeconds * 1000) / totalMs) * 100;
            const runWidth = ((job.durationInSeconds * 1000) / totalMs) * 100;
            const leftOffset = ((startMs - minTime) / totalMs) * 100;

            return (
              <div key={job.id} className="group relative flex h-8 items-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800">
                <div
                  className="absolute h-full border-y border-l border-amber-300/50 bg-amber-200/50"
                  style={{ left: `${leftOffset}%`, width: `${Math.max(0.5, queueWidth)}%` }}
                />
                <div
                  className={`absolute h-full border ${
                    job.conclusion === 'success'
                      ? 'border-green-600 bg-green-500'
                      : job.conclusion === 'skipped'
                        ? 'border-neutral-500 bg-neutral-400'
                        : 'border-red-600 bg-red-500'
                  }`}
                  style={{ left: `${leftOffset + queueWidth}%`, width: `${Math.max(0.5, runWidth)}%` }}
                />
                <div className="pointer-events-none relative z-10 flex w-full justify-between truncate px-3 text-xs font-medium text-neutral-800 drop-shadow-sm dark:text-neutral-200">
                  <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="pointer-events-auto max-w-[60%] truncate hover:underline">
                    {job.name}
                  </a>
                  <span className="pointer-events-auto rounded bg-white px-1 font-mono text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-neutral-900/80 dark:text-neutral-400">
                    Q: {formatDurationMinutes(job.queueDurationInSeconds)} | R: {formatDurationMinutes(job.durationInSeconds)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              <tr>
                <th className="cursor-pointer px-4 py-2" onClick={() => handleSort('name')}>Job Name</th>
                <th className="px-4 py-2">Status</th>
                <th className="cursor-pointer px-4 py-2" onClick={() => handleSort('queue')}>Queue Time</th>
                <th className="cursor-pointer px-4 py-2" onClick={() => handleSort('duration')}>Run Time</th>
                <th className="px-4 py-2 text-right">Links</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
              {sortedJobs.map((job) => (
                <tr key={job.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950">
                  <td className="px-4 py-2.5 font-medium text-neutral-800 dark:text-neutral-200">{job.name}</td>
                  <td className="px-4 py-2.5"><StatusBadge conclusion={job.conclusion} /></td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(job.queueDurationInSeconds)}</td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(job.durationInSeconds)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                      Logs
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TimingChart<T extends { id: number; name: string; queueTimeSeconds: number | undefined; e2eTimeSeconds: number }>({
  data,
  label,
}: {
  data: T[];
  label: string;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        No {label.toLowerCase()} selected. Use checkboxes to select items.
      </div>
    );
  }

  const chartData = data.map((item) => ({
    name: item.name.length > 24 ? `${item.name.slice(0, 22)}…` : item.name,
    queueTime: item.queueTimeSeconds !== undefined ? Math.round(item.queueTimeSeconds / 60) : 0,
    e2eTime: Math.round(item.e2eTimeSeconds / 60),
    hasQueueTime: item.queueTimeSeconds !== undefined,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">
          {label} Timing Metrics ({data.length} selected)
        </h4>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" className="dark:opacity-20" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#888' }} />
            <Tooltip formatter={(value: unknown) => (typeof value === 'number' ? `${value}m` : String(value))} />
            <Legend />
            <Bar dataKey="queueTime" name="Queue Time" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            <Bar dataKey="e2eTime" name="E2E Time" fill="#3b82f6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DashboardContent({
  initialFailedRepoKeys,
  initialRepoIndexesByKey,
  initialRepoOptions,
  initialSearchParams,
}: DashboardClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentQuery = parseDashboardQuery(searchParams);
  const [initialQuery] = useState(() => parseDashboardQuery(searchParamsToUrlSearchParams(initialSearchParams)));

  const [days, setDays] = useState(initialQuery.days);
  const [startDate, setStartDate] = useState(initialQuery.startDate);
  const [endDate, setEndDate] = useState(initialQuery.endDate);
  const [useCustomRange, setUseCustomRange] = useState(initialQuery.useCustomRange);
  const [filterName, setFilterName] = useState(initialQuery.filterName);
  const repoOptions = initialRepoOptions;
  const [selectedRepoKey, setSelectedRepoKey] = useState(() => {
    if (initialQuery.repoKey && initialRepoOptions.some((repo) => repo.key === initialQuery.repoKey)) {
      return initialQuery.repoKey;
    }
    return initialRepoOptions.length > 0 ? initialRepoOptions[0].key : '';
  });
  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>(METRIC_OPTIONS.map((metric) => metric.key));
  const [error, setError] = useState(repoOptions.length === 0 ? 'No repository data found under data/.' : '');
  const repoIndexesByKey = initialRepoIndexesByKey;
  const failedRepoKeys = initialFailedRepoKeys;
  const latestPrDate = useMemo(() => getLatestPrDate(repoIndexesByKey), [repoIndexesByKey]);
  const [detailsByNumber, setDetailsByNumber] = useState<Record<number, PullRequestDetailFile['pr']>>({});
  const [loadingDetailNumber, setLoadingDetailNumber] = useState<number | null>(null);
  const [expandedPrNumber, setExpandedPrNumber] = useState<number | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<number | null>(null);
  const [fallbackRuns, setFallbackRuns] = useState<Run[]>([]);
  const [fallbackRunsLoading, setFallbackRunsLoading] = useState(false);
  const [fallbackRunsError, setFallbackRunsError] = useState('');
  const [fallbackRunsScope, setFallbackRunsScope] = useState<'selected-range' | 'latest-retained'>('selected-range');
  const [shareNotice, setShareNotice] = useState('');
  const [workflowSortField, setWorkflowSortField] = useState<WorkflowSortField>('date');
  const [workflowSortOrder, setWorkflowSortOrder] = useState<WorkflowSortOrder>('desc');
  const [prLifecycleViewMode, setPrLifecycleViewMode] = useState<PrLifecycleViewMode>('pr');
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<number>>(new Set());
  const [selectedJobIds, setSelectedJobIds] = useState<Set<number>>(new Set());
  const [allWorkflows, setAllWorkflows] = useState<Run[]>([]);
  const [allWorkflowsLoading, setAllWorkflowsLoading] = useState(false);
  const [allWorkflowsError, setAllWorkflowsError] = useState('');
  const [jobSortField, setJobSortField] = useState<JobSortField>('duration');
  const [jobSortOrder, setJobSortOrder] = useState<'asc' | 'desc'>('desc');
  const previousSelectedRepoKeyRef = useRef(selectedRepoKey);
  const debouncedFilterName = useDebouncedValue(filterName, 250);

  const selectedRepo = useMemo(() => {
    if (repoOptions.length === 0) {
      return null;
    }

    return repoOptions.find((repo) => repo.key === selectedRepoKey) ?? repoOptions[0];
  }, [repoOptions, selectedRepoKey]);

  const dateRange = useMemo(
    () =>
      createDateRange({
        days,
        startDate: useCustomRange ? startDate : undefined,
        endDate: useCustomRange ? endDate : undefined,
        now: latestPrDate,
      }),
    [days, endDate, latestPrDate, startDate, useCustomRange]
  );

  useEffect(() => {
    setDays(currentQuery.days);
    setStartDate(currentQuery.startDate);
    setEndDate(currentQuery.endDate);
    setUseCustomRange(currentQuery.useCustomRange);
    setFilterName(currentQuery.filterName);
    if (currentQuery.repoKey) {
      setSelectedRepoKey(currentQuery.repoKey);
    }
  }, [
    currentQuery.days,
    currentQuery.endDate,
    currentQuery.filterName,
    currentQuery.repoKey,
    currentQuery.startDate,
    currentQuery.useCustomRange,
  ]);

  useEffect(() => {
    if (previousSelectedRepoKeyRef.current === selectedRepoKey) {
      return;
    }

    previousSelectedRepoKeyRef.current = selectedRepoKey;
    setDetailsByNumber({});
    setLoadingDetailNumber(null);
    setExpandedPrNumber(null);
    setExpandedWorkflowId(null);
    setError('');
    setPrLifecycleViewMode('pr');
    setSelectedWorkflowIds(new Set());
    setSelectedJobIds(new Set());
    setAllWorkflows([]);
    setAllWorkflowsError('');
  }, [selectedRepoKey]);

  useEffect(() => {
    const params = new URLSearchParams();

    if (useCustomRange) {
      params.set('useCustomRange', 'true');
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
    } else if (days !== 7) {
      params.set('days', String(days));
    }
    if (selectedRepo) params.set('repo', selectedRepo.key);
    if (debouncedFilterName) params.set('filterName', debouncedFilterName);

    const query = params.toString();
    const current = searchParams.toString();

    if (query === current) {
      return;
    }

    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [days, debouncedFilterName, endDate, pathname, router, searchParams, selectedRepo, startDate, useCustomRange]);

  useEffect(() => {
    if (!shareNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShareNotice('');
    }, 2500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [shareNotice]);

  const selectedRepoPrs = useMemo(
    () => (selectedRepo ? repoIndexesByKey[selectedRepo.key]?.prs ?? [] : []),
    [repoIndexesByKey, selectedRepo]
  );
  const selectedRepoIndex = selectedRepo ? repoIndexesByKey[selectedRepo.key] : undefined;
  const selectedRepoMetricsFailed = selectedRepo ? failedRepoKeys.includes(selectedRepo.key) : false;
  const selectedRepoHasPrArtifact = Boolean(selectedRepoIndex);
  const selectedRepoHasPartialPrResolution = Boolean(selectedRepoIndex?.partialPrResolution);
  const selectedRepoMissingPrArtifact = Boolean(selectedRepoIndex?.missingPrArtifact);
  const emptyMetricsMessage = selectedRepoMetricsFailed
    ? 'PR metrics artifact failed to load for this repository.'
    : selectedRepoMissingPrArtifact
      ? 'PR metrics have not been generated for this repository yet.'
    : selectedRepoHasPartialPrResolution
      ? 'PR metrics are partially resolved for this repository. More PRs may appear after future ETL runs.'
      : selectedRepoHasPrArtifact
        ? 'No PRs found for the selected repository and time range.'
        : 'PR metrics have not been generated for this repository yet.';

  const dateRangePrs = useMemo(() => {
    return filterByDateRange(selectedRepoPrs, dateRange);
  }, [dateRange, selectedRepoPrs]);

  const filteredPrs = useMemo(() => {
    let result = dateRangePrs;

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((pr) =>
        `${pr.number} ${pr.title} ${pr.branch} ${pr.author}`.toLowerCase().includes(query)
      );
    }

    return result;
  }, [dateRangePrs, filterName]);

  const shouldLoadWorkflowFallback = Boolean(
    selectedRepo && (selectedRepoMissingPrArtifact || selectedRepoHasPartialPrResolution || dateRangePrs.length === 0)
  );

  useEffect(() => {
    let cancelled = false;

    const loadFallbackRuns = async () => {
      if (!selectedRepo || !shouldLoadWorkflowFallback) {
        setFallbackRuns([]);
        setFallbackRunsError('');
        setFallbackRunsLoading(false);
        setFallbackRunsScope('selected-range');
        return;
      }

      setFallbackRunsLoading(true);
      setFallbackRunsError('');
      setFallbackRunsScope('selected-range');

      try {
        const runs = await callApi<Run[]>('fetchRunsFromIndex', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
          startDate: format(dateRange.start, 'yyyy-MM-dd'),
          endDate: format(dateRange.end, 'yyyy-MM-dd'),
        });

        if (cancelled) {
          return;
        }

        if (runs.length > 0) {
          setFallbackRuns(runs);
          setFallbackRunsScope('selected-range');
          return;
        }

        const latestRuns = await callApi<Run[]>('fetchLatestRunsFromIndex', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
        });

        if (cancelled) {
          return;
        }

        setFallbackRuns(latestRuns);
        setFallbackRunsScope(latestRuns.length > 0 ? 'latest-retained' : 'selected-range');
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load workflow fallback runs', err);
          setFallbackRuns([]);
          setFallbackRunsError('Failed to load workflow runs.');
          setFallbackRunsScope('selected-range');
        }
      } finally {
        if (!cancelled) {
          setFallbackRunsLoading(false);
        }
      }
    };

    void loadFallbackRuns();

    return () => {
      cancelled = true;
    };
  }, [dateRange.end, dateRange.start, selectedRepo, shouldLoadWorkflowFallback]);

  useEffect(() => {
    let cancelled = false;

    const loadAllWorkflows = async () => {
      if (!selectedRepo || (prLifecycleViewMode !== 'workflow' && prLifecycleViewMode !== 'job')) {
        setAllWorkflows([]);
        setAllWorkflowsLoading(false);
        setAllWorkflowsError('');
        return;
      }

      setAllWorkflowsLoading(true);
      setAllWorkflowsError('');

      try {
        const runs = await callApi<Run[]>('fetchRunsFromIndex', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
          startDate: format(dateRange.start, 'yyyy-MM-dd'),
          endDate: format(dateRange.end, 'yyyy-MM-dd'),
        });

        if (!cancelled) {
          setAllWorkflows(runs);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load workflows', err);
          setAllWorkflows([]);
          setAllWorkflowsError('Failed to load workflows.');
        }
      } finally {
        if (!cancelled) {
          setAllWorkflowsLoading(false);
        }
      }
    };

    void loadAllWorkflows();

    return () => {
      cancelled = true;
    };
  }, [dateRange.end, dateRange.start, selectedRepo, prLifecycleViewMode]);

  const unsortedFallbackRuns = useMemo(() => {
    let result = fallbackRuns;

    if (fallbackRunsScope === 'selected-range') {
      result = filterByDateRange(result, dateRange);
    }

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((run) => `${run.name} ${run.head_branch}`.toLowerCase().includes(query));
    }

    return result;
  }, [dateRange, fallbackRuns, fallbackRunsScope, filterName]);

  const filteredFallbackRuns = useMemo(() => {
    return sortWorkflows(unsortedFallbackRuns, workflowSortField, workflowSortOrder);
  }, [unsortedFallbackRuns, workflowSortField, workflowSortOrder]);

  const showWorkflowFallback = filteredPrs.length === 0 && filteredFallbackRuns.length > 0;

  const overviewRows = useMemo<RepoOverviewRow[]>(
    () =>
      buildRepoOverviewRows(
        repoOptions.map((repo) => ({
          repoKey: repo.key,
          prs: repoIndexesByKey[repo.key]?.prs ?? [],
        })),
        dateRange
      ),
    [dateRange, repoIndexesByKey, repoOptions]
  );

  const dailyTrend = useMemo<DailyTrendPoint[]>(
    () => buildDailyTrend(selectedRepoPrs, dateRange),
    [dateRange, selectedRepoPrs]
  );

  const activeMetricOptions = METRIC_OPTIONS.filter((metric) => selectedMetrics.includes(metric.key));

  const handleRepoSelection = (repoKey: string) => {
    if (repoKey === selectedRepoKey) {
      return;
    }

    setSelectedRepoKey(repoKey);
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareNotice('Shareable link copied.');
    } catch {
      setShareNotice('Unable to copy link.');
    }
  };

  const loadDetail = async (number: number) => {
    if (!selectedRepo) {
      return;
    }

    if (detailsByNumber[number]) {
      setExpandedPrNumber(expandedPrNumber === number ? null : number);
      setExpandedWorkflowId(null);
      return;
    }

    setLoadingDetailNumber(number);
    try {
      const detail = await callApi<PullRequestDetailFile>('fetchPullRequestDetail', {
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        number,
      });

      if (previousSelectedRepoKeyRef.current === selectedRepo.key) {
        setDetailsByNumber((current) => ({ ...current, [number]: detail.pr }));
        setExpandedPrNumber(number);
        setExpandedWorkflowId(null);
      }
    } catch (err) {
      console.error('Failed to load PR detail', err);
      setError(`Failed to load PR #${number}`);
    } finally {
      setLoadingDetailNumber(null);
    }
  };

  const toggleWorkflowSort = (field: WorkflowSortField) => {
    if (workflowSortField === field) {
      if (workflowSortOrder === 'desc') setWorkflowSortOrder('asc');
      else if (workflowSortOrder === 'asc') setWorkflowSortOrder('none');
      else setWorkflowSortOrder('desc');
      return;
    }

    setWorkflowSortField(field);
    setWorkflowSortOrder('desc');
  };

  const getSortedWorkflows = (workflows: Run[]) => {
    return sortWorkflows(workflows, workflowSortField, workflowSortOrder);
  };

  const toggleMetric = (metricKey: MetricKey) => {
    setSelectedMetrics((current) => {
      if (current.includes(metricKey)) {
        return current.length === 1 ? current : current.filter((item) => item !== metricKey);
      }

      return [...current, metricKey];
    });
  };

  const toggleWorkflowSelection = (id: number) => {
    setSelectedWorkflowIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleJobSelection = (id: number) => {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllWorkflows = () => {
    if (selectedWorkflowIds.size === sortedAllWorkflows.length && sortedAllWorkflows.length > 0) {
      setSelectedWorkflowIds(new Set());
    } else {
      setSelectedWorkflowIds(new Set(sortedAllWorkflows.map((w) => w.id)));
    }
  };

  const toggleAllJobs = () => {
    if (selectedJobIds.size === sortedAllJobTimingData.length && sortedAllJobTimingData.length > 0) {
      setSelectedJobIds(new Set());
    } else {
      setSelectedJobIds(new Set(sortedAllJobTimingData.map((j) => j.id)));
    }
  };

  const sortedAllWorkflows = useMemo(() => {
    let result = allWorkflows;
    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((run) => `${run.name} ${run.head_branch}`.toLowerCase().includes(query));
    }
    return sortWorkflows(result, workflowSortField, workflowSortOrder);
  }, [allWorkflows, filterName, workflowSortField, workflowSortOrder]);

  const allWorkflowTimingData = useMemo(() => buildWorkflowTimingData(allWorkflows), [allWorkflows]);
  const selectedWorkflowTimingData = useMemo(
    () => allWorkflowTimingData.filter((w) => selectedWorkflowIds.has(w.id)),
    [allWorkflowTimingData, selectedWorkflowIds]
  );

  const allJobTimingData = useMemo(() => buildJobTimingData(allWorkflows), [allWorkflows]);
  const sortedAllJobTimingData = useMemo(() => {
    let result = [...allJobTimingData];
    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((job) => `${job.name} ${job.workflowName}`.toLowerCase().includes(query));
    }
    result.sort((a, b) => {
      let comparison = 0;
      if (jobSortField === 'name') comparison = a.name.localeCompare(b.name);
      else if (jobSortField === 'queue') comparison = a.queueTimeSeconds - b.queueTimeSeconds;
      else if (jobSortField === 'duration') comparison = a.e2eTimeSeconds - b.e2eTimeSeconds;
      return jobSortOrder === 'asc' ? comparison : -comparison;
    });
    return result;
  }, [allJobTimingData, filterName, jobSortField, jobSortOrder]);
  const selectedJobTimingData = useMemo(
    () => sortedAllJobTimingData.filter((j) => selectedJobIds.has(j.id)),
    [sortedAllJobTimingData, selectedJobIds]
  );

  const handleViewModeChange = (mode: PrLifecycleViewMode) => {
    setPrLifecycleViewMode(mode);
    setSelectedWorkflowIds(new Set());
    setSelectedJobIds(new Set());
  };

  const toggleJobSort = (field: JobSortField) => {
    if (jobSortField === field) {
      setJobSortOrder(jobSortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setJobSortField(field);
      setJobSortOrder('desc');
    }
  };

  if (!selectedRepo) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div className="flex flex-col items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <Activity className="h-8 w-8 animate-pulse text-blue-500 dark:text-blue-400" />
          <p>{error || 'Loading tracked repositories...'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 p-4 font-sans text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 md:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col space-y-6">
        <header className="flex flex-col items-start justify-between gap-4 rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 md:flex-row md:items-center">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Activity className="text-blue-500 dark:text-blue-400" />
              Action Insight
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Compare repository CI health, then drill into PR lifecycle details for {selectedRepo.key}.
            </p>
          </div>

          <div className="flex w-full items-center justify-end gap-2 md:w-auto">
            {shareNotice ? (
              <span
                aria-live="polite"
                className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300"
              >
                {shareNotice}
              </span>
            ) : null}
            <button type="button" onClick={copyShareLink} title="Copy link to current view" className="flex items-center justify-center rounded-lg bg-neutral-100 p-2 text-neutral-600 transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700">
              <Share2 className="h-5 w-5" />
            </button>
            <a href="https://github.com/pkking/action-insight/issues/new/choose" target="_blank" rel="noopener noreferrer" title="Give Feedback / Report Bug" className="flex items-center justify-center rounded-lg bg-neutral-100 p-2 text-neutral-600 transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700">
              <MessageSquare className="h-5 w-5" />
            </a>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900">
            <label htmlFor="repo-select" className="whitespace-nowrap text-sm text-neutral-500 dark:text-neutral-400">Trend Repo</label>
            <select id="repo-select" value={selectedRepo.key} onChange={(event) => handleRepoSelection(event.target.value)} className="min-w-56 bg-transparent text-sm text-neutral-700 outline-none dark:text-neutral-300">
              {repoOptions.map((repo) => (
                <option key={repo.key} value={repo.key}>{repo.key}</option>
              ))}
            </select>
          </div>

          {[7, 14, 30, 90].map((value) => (
            <button
              type="button"
              key={value}
              onClick={() => {
                setUseCustomRange(false);
                setDays(value);
              }}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-all ${
                days === value && !useCustomRange
                  ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950'
              }`}
            >
              Last {value} Days
            </button>
          ))}

          <button
            type="button"
            onClick={() => setUseCustomRange(true)}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all ${
              useCustomRange
                ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950'
            }`}
          >
            <CalendarIcon className="h-4 w-4" />
            Custom
          </button>

          {useCustomRange && (
            <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-900">
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="bg-transparent px-2 py-1 text-sm text-neutral-700 outline-none dark:text-neutral-300" />
              <span className="text-neutral-400">-</span>
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="bg-transparent px-2 py-1 text-sm text-neutral-700 outline-none dark:text-neutral-300" />
            </div>
          )}
        </div>

        {error ? (
          <div className="rounded-lg border border-red-100 bg-red-50 p-4 text-red-600 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">{error}</div>
        ) : null}

        {failedRepoKeys.length > 0 ? (
          <div className="rounded-lg border border-amber-100 bg-amber-50 p-4 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            Failed to load metrics for: {failedRepoKeys.join(', ')}
          </div>
        ) : null}

        {selectedRepoHasPartialPrResolution ? (
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
            Partial PR resolution for {selectedRepo.key}: {selectedRepoIndex?.resolvedPrShaCount ?? 0} SHA(s) resolved,
            {' '}{selectedRepoIndex?.unresolvedPrShaCount ?? 0} still pending.
          </div>
        ) : null}

        <section className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="border-b border-neutral-100 p-6 dark:border-neutral-800">
                <h2 className="text-lg font-bold">Repository Overview</h2>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Compare PR E2E, CI E2E, review time, and CI SLA across tracked repositories for the selected time window.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                    <tr>
                      <th className="px-6 py-3">Repo</th>
                      <th className="px-6 py-3">PR E2E P90</th>
                      <th className="px-6 py-3">CI E2E P90</th>
                      <th className="px-6 py-3">PR Review P90</th>
                      <th className="px-6 py-3">CI E2E SLA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {overviewRows.map((row) => {
                      const isSelected = row.repoKey === selectedRepo.key;
                      return (
                        <tr
                          key={row.repoKey}
                          onClick={() => handleRepoSelection(row.repoKey)}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? 'bg-blue-50/60 dark:bg-blue-900/10' : 'hover:bg-neutral-50 dark:hover:bg-neutral-950/60'
                          }`}
                        >
                          <td className="px-6 py-4">
                            <button
                              type="button"
                              aria-label={`Select repo ${row.repoKey}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRepoSelection(row.repoKey);
                              }}
                              className="text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                              <div className="font-medium text-neutral-900 dark:text-neutral-100">{row.repoKey}</div>
                              <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{row.totalPrs} PRs in range</div>
                            </button>
                          </td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">
                            {formatMetricMinutes(row.prE2EP90Minutes)}
                            {row.sampleCount > 0 && (
                              <span className={`ml-1 text-xs ${row.sampleCount < LOW_SAMPLE_THRESHOLD ? 'text-amber-600 dark:text-amber-400' : ''}`}>(n={row.sampleCount})</span>
                            )}
                          </td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">
                            {formatMetricMinutes(row.ciE2EP90Minutes)}
                            {row.sampleCount > 0 && (
                              <span className={`ml-1 text-xs ${row.sampleCount < LOW_SAMPLE_THRESHOLD ? 'text-amber-600 dark:text-amber-400' : ''}`}>(n={row.sampleCount})</span>
                            )}
                          </td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">
                            {formatMetricMinutes(row.reviewP90Minutes)}
                            {row.sampleCount > 0 && (
                              <span className={`ml-1 text-xs ${row.sampleCount < LOW_SAMPLE_THRESHOLD ? 'text-amber-600 dark:text-amber-400' : ''}`}>(n={row.sampleCount})</span>
                            )}
                          </td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">
                            {formatRate(row.ciE2ESlaRate)}
                            {row.sampleCount > 0 && (
                              <span className={`ml-1 text-xs ${row.sampleCount < LOW_SAMPLE_THRESHOLD ? 'text-amber-600 dark:text-amber-400' : ''}`}>(n={row.sampleCount})</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
        </section>

        <section className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-bold">
                    <CalendarIcon className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
                    {selectedRepo.key} Daily Trends
                  </h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Daily aggregation for all supported overview metrics. Duration metrics use minutes; SLA uses percentage.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {METRIC_OPTIONS.map((metric) => (
                    <label key={metric.key} className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                      <input
                        type="checkbox"
                        checked={selectedMetrics.includes(metric.key)}
                        onChange={() => toggleMetric(metric.key)}
                        aria-label={metric.label}
                      />
                      {metric.label}
                    </label>
                  ))}
                </div>
              </div>

              {dailyTrend.length === 0 ? (
                <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  {showWorkflowFallback
                    ? fallbackRunsScope === 'latest-retained'
                      ? 'No PR metrics or workflow runs were found in the selected range. Latest retained raw workflow runs are shown below.'
                      : (selectedRepoMissingPrArtifact || selectedRepoHasPartialPrResolution)
                        ? 'PR metrics are unavailable for this repository. Raw workflow runs are shown below.'
                        : 'No PR metrics were found in the selected range. Raw workflow runs are shown below.'
                    : emptyMetricsMessage}
                </div>
              ) : (
                <div className="h-72 select-none">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dailyTrend}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" className="dark:opacity-20" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis yAxisId="minutes" tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} />
                      <Tooltip />
                      <Legend />
                      {activeMetricOptions.map((metric) => (
                        <Line
                          key={metric.key}
                          type="monotone"
                          dataKey={metric.key}
                          name={metric.label}
                          stroke={metric.stroke}
                          strokeWidth={3}
                          dot={false}
                          activeDot={{ r: 6 }}
                          animationDuration={300}
                          connectNulls
                          yAxisId={metric.yAxisId}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
        </section>

        <section className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex flex-col gap-4 border-b border-neutral-100 p-6 dark:border-neutral-800 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-bold">PR Lifecycle</h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Drill into PR and workflow details for {selectedRepo.key}.</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
                    {([['pr', 'PR'], ['workflow', 'Workflow'], ['job', 'Job']] as [PrLifecycleViewMode, string][]).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => handleViewModeChange(mode)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          prLifecycleViewMode === mode
                            ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100'
                            : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950">
                    <Filter className="h-4 w-4 text-neutral-400 dark:text-neutral-500" />
                    <input
                      type="text"
                      placeholder={prLifecycleViewMode === 'pr' ? 'Filter by PR, title, branch...' : prLifecycleViewMode === 'workflow' ? 'Filter by workflow, branch...' : 'Filter by job, workflow...'}
                      value={filterName}
                      onChange={(event) => setFilterName(event.target.value)}
                      className="w-48 bg-transparent outline-none"
                    />
                  </div>
                </div>
              </div>

              {prLifecycleViewMode === 'pr' ? (
                /* ===== PR VIEW (existing behavior) ===== */
                filteredPrs.length === 0 ? (
                  showWorkflowFallback ? (
                    <div className="overflow-x-auto">
                      <div className="border-b border-blue-100 bg-blue-50 px-6 py-4 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
                        {fallbackRunsScope === 'latest-retained'
                          ? `No PR metrics or workflow runs were found for ${selectedRepo.key} in the selected date range. Showing latest retained raw workflow runs instead.`
                          : (selectedRepoMissingPrArtifact || selectedRepoHasPartialPrResolution)
                            ? `PR metrics are unavailable for ${selectedRepo.key}. Showing raw workflow runs for the selected date range instead.`
                            : `No PR metrics were found for ${selectedRepo.key} in the selected date range. Showing raw workflow runs instead.`}
                      </div>
                      <table className="w-full text-left text-sm">
                        <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                          <tr>
                            <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('name')}>Workflow</th>
                            <th className="px-6 py-3">Branch</th>
                            <th className="px-6 py-3">Status</th>
                            <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('date')}>Created</th>
                            <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('duration')}>Duration</th>
                            <th className="px-6 py-3 text-right">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                          {filteredFallbackRuns.map((workflow) => (
                            <React.Fragment key={workflow.id}>
                              <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50">
                                <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">{workflow.name}</td>
                                <td className="px-6 py-4 font-mono text-xs text-neutral-500 dark:text-neutral-400">{workflow.head_branch}</td>
                                <td className="px-6 py-4"><StatusBadge conclusion={workflow.conclusion} /></td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(workflow.created_at), 'MMM dd, HH:mm')}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(workflow.durationInSeconds)}</td>
                                <td className="px-6 py-4 text-right">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedWorkflowId((current) => current === workflow.id ? null : workflow.id)}
                                    className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                                  >
                                    {expandedWorkflowId === workflow.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                    Jobs
                                  </button>
                                  <a href={workflow.html_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                                    <ExternalLink className="h-4 w-4" />
                                  </a>
                                </td>
                              </tr>
                              {expandedWorkflowId === workflow.id ? (
                                <tr>
                                  <td colSpan={6} className="p-0">
                                    <JobDetailsView run={workflow} />
                                  </td>
                                </tr>
                              ) : null}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                      {emptyMetricsMessage}
                      {shouldLoadWorkflowFallback && fallbackRunsLoading ? (
                        <span className="mt-2 block text-xs text-neutral-400 dark:text-neutral-500">Loading raw workflow fallback...</span>
                      ) : null}
                      {shouldLoadWorkflowFallback && fallbackRunsError ? (
                        <span className="mt-2 block text-xs text-neutral-400 dark:text-neutral-500">Raw workflow fallback is temporarily unavailable.</span>
                      ) : null}
                    </div>
                  )
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                        <tr>
                          <th className="px-6 py-3">PR / Branch</th>
                          <th className="px-6 py-3">Status</th>
                          <th className="px-6 py-3">T1 PR Created</th>
                          <th className="px-6 py-3">T2 CI Started</th>
                          <th className="px-6 py-3">T3 CI Completed</th>
                          <th className="px-6 py-3">T4 PR Merged</th>
                          <th className="px-6 py-3">Submit→CI Start</th>
                          <th className="px-6 py-3">CI Start→CI End</th>
                          <th className="px-6 py-3">Submit→Merge</th>
                          <th className="px-6 py-3 text-right">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                        {filteredPrs.map((pr) => {
                          const detail = detailsByNumber[pr.number];
                          const workflows = detail ? getSortedWorkflows(detail.workflows) : [];

                          return (
                            <React.Fragment key={pr.number}>
                              <tr className="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950/50">
                                <td className="px-6 py-4">
                                  <div className="font-medium text-neutral-900 dark:text-neutral-100">PR #{pr.number}</div>
                                  <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{pr.title}</div>
                                  <div className="mt-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">{pr.branch}</div>
                                </td>
                                <td className="px-6 py-4"><StatusBadge conclusion={pr.conclusion} /></td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(pr.created_at), 'MMM dd, HH:mm')}</td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{pr.ci_started_at ? format(new Date(pr.ci_started_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{pr.ci_completed_at ? format(new Date(pr.ci_completed_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{pr.merged_at ? format(new Date(pr.merged_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.timeToCiStartInSeconds)}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.ciDurationInSeconds)}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.timeToMergeInSeconds)}</td>
                                <td className="px-6 py-4 text-right">
                                  <button type="button" onClick={() => void loadDetail(pr.number)} className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
                                    {expandedPrNumber === pr.number ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                    {loadingDetailNumber === pr.number ? 'Loading...' : 'Workflows'}
                                  </button>
                                  <a href={pr.html_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300" title="View PR on GitHub">
                                    <ExternalLink className="h-4 w-4" />
                                  </a>
                                </td>
                              </tr>

                              {expandedPrNumber === pr.number && detail && (
                                <>
                                  <tr className="bg-neutral-50 dark:bg-neutral-950/50">
                                    <td colSpan={10} className="p-6">
                                      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                                        <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                                          <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">Workflows</div>
                                          <div className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{detail.workflowCount}</div>
                                        </div>
                                        <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                                          <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">Successful</div>
                                          <div className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{detail.successfulWorkflowCount}</div>
                                          <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{detail.successfulWorkflowCount} / {detail.workflowCount} successful workflows</div>
                                        </div>
                                        <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                                          <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">CI Duration</div>
                                          <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{formatDurationMinutes(detail.ciDurationInSeconds)}</div>
                                        </div>
                                        <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                                          <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">PR E2E</div>
                                          <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{formatDurationMinutes(detail.timeToMergeInSeconds)}</div>
                                          {detail.partialCiHistory ? (
                                            <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">Partial CI history</div>
                                          ) : null}
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                  <tr>
                                    <td colSpan={10} className="p-0">
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                          <thead className="bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                                            <tr>
                                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('name')}>Workflow</th>
                                              <th className="px-6 py-3">Status</th>
                                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('date')}>Created</th>
                                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('duration')}>Duration</th>
                                              <th className="px-6 py-3 text-right">Details</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                            {workflows.map((workflow) => (
                                              <React.Fragment key={workflow.id}>
                                                <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50">
                                                  <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">{workflow.name}</td>
                                                  <td className="px-6 py-4"><StatusBadge conclusion={workflow.conclusion} /></td>
                                                  <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(workflow.created_at), 'MMM dd, HH:mm')}</td>
                                                  <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(workflow.durationInSeconds)}</td>
                                                  <td className="px-6 py-4 text-right">
                                                    <button
                                                      type="button"
                                                      onClick={() => setExpandedWorkflowId((current) => current === workflow.id ? null : workflow.id)}
                                                      className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                                                    >
                                                      {expandedWorkflowId === workflow.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                                      Jobs
                                                    </button>
                                                    <a href={workflow.html_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                                                      <ExternalLink className="h-4 w-4" />
                                                    </a>
                                                  </td>
                                                </tr>
                                                {expandedWorkflowId === workflow.id ? (
                                                  <tr>
                                                    <td colSpan={5} className="p-0">
                                                      <JobDetailsView run={workflow} />
                                                    </td>
                                                  </tr>
                                                ) : null}
                                              </React.Fragment>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                </>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              ) : prLifecycleViewMode === 'workflow' ? (
                /* ===== WORKFLOW VIEW ===== */
                <div>
                  {allWorkflowsError ? (
                    <div className="p-8 text-center text-sm text-red-500 dark:text-red-400">Failed to load workflows. Please try again later.</div>
                  ) : allWorkflowsLoading ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading workflows...</div>
                  ) : sortedAllWorkflows.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No workflows found for the selected date range.</div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                            <tr>
                              <th className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedWorkflowIds.size === sortedAllWorkflows.length && sortedAllWorkflows.length > 0}
                                  onChange={toggleAllWorkflows}
                                  aria-label="Select all workflows"
                                />
                              </th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('name')}>Workflow</th>
                              <th className="px-6 py-3">Branch</th>
                              <th className="px-6 py-3">Status</th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('date')}>Created</th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleWorkflowSort('duration')}>Duration</th>
                              <th className="px-6 py-3">Queue Time</th>
                              <th className="px-6 py-3">E2E Time</th>
                              <th className="px-6 py-3 text-right">Link</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                            {sortedAllWorkflows.map((workflow) => {
                              const queueTime = calculateWorkflowQueueTime(workflow);
                              return (
                                <tr key={workflow.id} className={`hover:bg-neutral-50 dark:hover:bg-neutral-950/50 ${selectedWorkflowIds.has(workflow.id) ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                                  <td className="px-4 py-4">
                                    <input
                                      type="checkbox"
                                      checked={selectedWorkflowIds.has(workflow.id)}
                                      onChange={() => toggleWorkflowSelection(workflow.id)}
                                      aria-label={`Select ${workflow.name}`}
                                    />
                                  </td>
                                  <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">{workflow.name}</td>
                                  <td className="px-6 py-4 font-mono text-xs text-neutral-500 dark:text-neutral-400">{workflow.head_branch}</td>
                                  <td className="px-6 py-4"><StatusBadge conclusion={workflow.conclusion} /></td>
                                  <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(workflow.created_at), 'MMM dd, HH:mm')}</td>
                                  <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(workflow.durationInSeconds)}</td>
                                  <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{queueTime !== undefined ? formatDurationMinutes(queueTime) : 'N/A'}</td>
                                  <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(workflow.durationInSeconds)}</td>
                                  <td className="px-6 py-4 text-right">
                                    <a href={workflow.html_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                                      <ExternalLink className="h-4 w-4" />
                                    </a>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="border-t border-neutral-100 p-6 dark:border-neutral-800">
                        <TimingChart data={selectedWorkflowTimingData} label="Workflow" />
                      </div>
                    </>
                  )}
                </div>
              ) : (
                /* ===== JOB VIEW ===== */
                <div>
                  {allWorkflowsError ? (
                    <div className="p-8 text-center text-sm text-red-500 dark:text-red-400">Failed to load jobs. Please try again later.</div>
                  ) : allWorkflowsLoading ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading jobs...</div>
                  ) : sortedAllJobTimingData.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No jobs found for the selected date range.</div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                            <tr>
                              <th className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedJobIds.size === sortedAllJobTimingData.length && sortedAllJobTimingData.length > 0}
                                  onChange={toggleAllJobs}
                                  aria-label="Select all jobs"
                                />
                              </th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleJobSort('name')}>Job Name</th>
                              <th className="px-6 py-3">Workflow</th>
                              <th className="px-6 py-3">Status</th>
                              <th className="px-6 py-3">Created</th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleJobSort('queue')}>Queue Time</th>
                              <th className="cursor-pointer px-6 py-3" onClick={() => toggleJobSort('duration')}>E2E Time</th>
                              <th className="px-6 py-3 text-right">Link</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                            {sortedAllJobTimingData.map((job) => (
                              <tr key={job.id} className={`hover:bg-neutral-50 dark:hover:bg-neutral-950/50 ${selectedJobIds.has(job.id) ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                                <td className="px-4 py-4">
                                  <input
                                    type="checkbox"
                                    checked={selectedJobIds.has(job.id)}
                                    onChange={() => toggleJobSelection(job.id)}
                                    aria-label={`Select ${job.name}`}
                                  />
                                </td>
                                <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">{job.name}</td>
                                <td className="px-6 py-4 text-xs text-neutral-500 dark:text-neutral-400">{job.workflowName}</td>
                                <td className="px-6 py-4"><StatusBadge conclusion={job.conclusion} /></td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(job.created_at), 'MMM dd, HH:mm')}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(job.queueTimeSeconds)}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(job.e2eTimeSeconds)}</td>
                                <td className="px-6 py-4 text-right">
                                  <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 p-1.5 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                                    <ExternalLink className="h-4 w-4" />
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="border-t border-neutral-100 p-6 dark:border-neutral-800">
                        <TimingChart data={selectedJobTimingData} label="Job" />
                      </div>
                    </>
                  )}
                </div>
              )}
        </section>
      </div>
    </div>
  );
}

export default function DashboardClient(props: DashboardClientProps) {
  return <DashboardContent {...props} />;
}
