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
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, isAfter, isBefore } from 'date-fns';

import { fetchRuns } from '@/lib/data-fetcher';
import { buildDailyTrend, buildRepoOverviewRows, createDateRange } from '@/lib/overview-metrics';
import { fetchPullRequestDetail } from '@/lib/pr-data-fetcher';
import type { RepoOption } from '@/lib/server-homepage-data';
import type {
  DailyTrendPoint,
  PullRequestDetailFile,
  PullRequestIndexFile,
  RepoOverviewRow,
  Run,
} from '@/lib/types';

type JobSortField = 'queue' | 'duration' | 'name';
type WorkflowSortField = 'date' | 'duration' | 'name';
type WorkflowSortOrder = 'asc' | 'desc' | 'none';
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
      <XCircle className="h-3.5 w-3.5" /> {conclusion || 'Failed'}
    </span>
  );
}

function JobDetailsView({ run }: { run: Run }) {
  const [viewMode, setViewMode] = useState<'timeline' | 'table'>('timeline');
  const [sortField, setSortField] = useState<JobSortField>('duration');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

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

  const minTime = Math.min(...run.jobs.map((job) => new Date(job.created_at || job.started_at || 0).getTime()));
  const maxTime = Math.max(
    ...run.jobs.map((job) => new Date(job.completed_at || job.started_at || new Date().toISOString()).getTime())
  );
  const totalMs = Math.max(1000, maxTime - minTime);

  return (
    <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">Job Execution Details</h4>
        <div className="flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
          <button
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
          {run.jobs.map((job) => {
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
  const [repoOptions] = useState<RepoOption[]>(initialRepoOptions);
  const [selectedRepoKey, setSelectedRepoKey] = useState(initialQuery.repoKey);
  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>(METRIC_OPTIONS.map((metric) => metric.key));
  const [error, setError] = useState(repoOptions.length === 0 ? 'No repository data found under data/.' : '');
  const [repoIndexesByKey] = useState<Record<string, PullRequestIndexFile>>(initialRepoIndexesByKey);
  const [failedRepoKeys] = useState<string[]>(initialFailedRepoKeys);
  const [detailsByNumber, setDetailsByNumber] = useState<Record<number, PullRequestDetailFile['pr']>>({});
  const [loadingDetailNumber, setLoadingDetailNumber] = useState<number | null>(null);
  const [expandedPrNumber, setExpandedPrNumber] = useState<number | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<number | null>(null);
  const [fallbackRuns, setFallbackRuns] = useState<Run[]>([]);
  const [fallbackRunsLoading, setFallbackRunsLoading] = useState(false);
  const [fallbackRunsError, setFallbackRunsError] = useState('');
  const [workflowSortField, setWorkflowSortField] = useState<WorkflowSortField>('date');
  const [workflowSortOrder, setWorkflowSortOrder] = useState<WorkflowSortOrder>('desc');
  const previousSelectedRepoKeyRef = useRef(selectedRepoKey);

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
      }),
    [days, endDate, startDate, useCustomRange]
  );

  useEffect(() => {
    if (repoOptions.length === 0) {
      return;
    }

    if (!initialQuery.repoKey || !repoOptions.some((repo) => repo.key === initialQuery.repoKey)) {
      setSelectedRepoKey(repoOptions[0].key);
    }
  }, [initialQuery.repoKey, repoOptions]);

  useEffect(() => {
    setDays(currentQuery.days);
    setStartDate(currentQuery.startDate);
    setEndDate(currentQuery.endDate);
    setUseCustomRange(currentQuery.useCustomRange);
    setFilterName(currentQuery.filterName);
    setSelectedRepoKey(currentQuery.repoKey);
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
    if (filterName) params.set('filterName', filterName);

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [days, endDate, filterName, pathname, router, selectedRepo, startDate, useCustomRange]);

  const selectedRepoPrs = useMemo(
    () => (selectedRepo ? repoIndexesByKey[selectedRepo.key]?.prs ?? [] : []),
    [repoIndexesByKey, selectedRepo]
  );
  const selectedRepoIndex = selectedRepo ? repoIndexesByKey[selectedRepo.key] : undefined;
  const selectedRepoMetricsFailed = selectedRepo ? failedRepoKeys.includes(selectedRepo.key) : false;
  const selectedRepoHasPrArtifact = Boolean(selectedRepoIndex);
  const selectedRepoHasPartialPrResolution = Boolean(selectedRepoIndex?.partialPrResolution);
  const selectedRepoMissingPrArtifact = Boolean(selectedRepoIndex?.missingPrArtifact);
  const shouldLoadWorkflowFallback = Boolean(
    selectedRepo && (selectedRepoMissingPrArtifact || selectedRepoHasPartialPrResolution)
  );
  const emptyMetricsMessage = selectedRepoMetricsFailed
    ? 'PR metrics artifact failed to load for this repository.'
    : selectedRepoMissingPrArtifact
      ? 'PR metrics have not been generated for this repository yet.'
    : selectedRepoHasPartialPrResolution
      ? 'PR metrics are partially resolved for this repository. More PRs may appear after future ETL runs.'
      : selectedRepoHasPrArtifact
        ? 'No PRs found for the selected repository and time range.'
        : 'PR metrics have not been generated for this repository yet.';

  useEffect(() => {
    let cancelled = false;

    const loadFallbackRuns = async () => {
      if (!selectedRepo || !shouldLoadWorkflowFallback) {
        setFallbackRuns([]);
        setFallbackRunsError('');
        setFallbackRunsLoading(false);
        return;
      }

      setFallbackRunsLoading(true);
      setFallbackRunsError('');

      try {
        const runs = await fetchRuns(selectedRepo.owner, selectedRepo.repo, {
          startDate: format(dateRange.start, 'yyyy-MM-dd'),
          endDate: format(dateRange.end, 'yyyy-MM-dd'),
        });

        if (cancelled) {
          return;
        }

        setFallbackRuns(runs);
      } catch (err) {
        if (!cancelled) {
          setFallbackRuns([]);
          setFallbackRunsError(err instanceof Error ? err.message : 'Failed to load workflow runs.');
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

  const filteredPrs = useMemo(() => {
    let result = [...selectedRepoPrs];

    result = result.filter((pr) => {
      const createdAt = new Date(pr.created_at);
      return !isBefore(createdAt, dateRange.start) && !isAfter(createdAt, dateRange.end);
    });

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((pr) =>
        `${pr.number} ${pr.title} ${pr.branch} ${pr.author}`.toLowerCase().includes(query)
      );
    }

    return result;
  }, [dateRange.end, dateRange.start, filterName, selectedRepoPrs]);

  const unsortedFallbackRuns = useMemo(() => {
    let result = [...fallbackRuns];

    result = result.filter((run) => {
      const createdAt = new Date(run.created_at);
      return !isBefore(createdAt, dateRange.start) && !isAfter(createdAt, dateRange.end);
    });

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((run) => `${run.name} ${run.head_branch}`.toLowerCase().includes(query));
    }

    return result;
  }, [dateRange.end, dateRange.start, fallbackRuns, filterName]);

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

  const copyShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    alert('Shareable link copied to clipboard!');
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
      const detail = await fetchPullRequestDetail(selectedRepo.owner, selectedRepo.repo, number);
      setDetailsByNumber((current) => ({ ...current, [number]: detail.pr }));
      setExpandedPrNumber(number);
      setExpandedWorkflowId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load PR #${number}`);
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

          <div className="flex w-full gap-2 md:w-auto">
            <button onClick={copyShareLink} title="Copy link to current view" className="flex items-center justify-center rounded-lg bg-neutral-100 p-2 text-neutral-600 transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700">
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
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatMetricMinutes(row.prE2EP90Minutes)}</td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatMetricMinutes(row.ciE2EP90Minutes)}</td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatMetricMinutes(row.reviewP90Minutes)}</td>
                          <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatRate(row.ciE2ESlaRate)}</td>
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
                  {showWorkflowFallback ? 'PR metrics are unavailable for this repository. Raw workflow runs are shown below.' : emptyMetricsMessage}
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
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950">
                  <Filter className="h-4 w-4 text-neutral-400 dark:text-neutral-500" />
                  <input type="text" placeholder="Filter by PR, title, branch..." value={filterName} onChange={(event) => setFilterName(event.target.value)} className="w-48 bg-transparent outline-none" />
                </div>
              </div>

              {filteredPrs.length === 0 ? (
                showWorkflowFallback ? (
                  <div className="overflow-x-auto">
                    <div className="border-b border-blue-100 bg-blue-50 px-6 py-4 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
                      PR metrics are unavailable for {selectedRepo.key}. Showing raw workflow runs for the selected date range instead.
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
                                <button onClick={() => void loadDetail(pr.number)} className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
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
              )}
        </section>
      </div>
    </div>
  );
}

export default function DashboardClient(props: DashboardClientProps) {
  return <DashboardContent {...props} />;
}
