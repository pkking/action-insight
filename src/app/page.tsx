'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  AlignLeft,
  Calendar as CalendarIcon,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Filter,
  Info,
  LayoutList,
  MessageSquare,
  Share2,
  XCircle,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { endOfDay, format, isAfter, isBefore, parseISO, startOfDay, subDays } from 'date-fns';

import { fetchPullRequestDetail, fetchPullRequestIndex } from '@/lib/pr-data-fetcher';
import type { PullRequestDetailFile, PullRequestMetricsSummary, Run } from '@/lib/types';

type RepoOption = { owner: string; repo: string; key: string };

type JobSortField = 'queue' | 'duration' | 'name';

type WorkflowSortField = 'date' | 'duration' | 'name';

type WorkflowSortOrder = 'asc' | 'desc' | 'none';

function formatDuration(seconds?: number) {
  if (seconds === undefined) {
    return 'N/A';
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function StatusBadge({ conclusion }: { conclusion: string }) {
  if (conclusion === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200/50 dark:border-green-800/50">
        <CheckCircle className="w-3.5 h-3.5" /> Success
      </span>
    );
  }

  if (conclusion === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700">
        <Info className="w-3.5 h-3.5" /> Skipped
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200/50 dark:border-red-800/50">
      <XCircle className="w-3.5 h-3.5" /> {conclusion || 'Failed'}
    </span>
  );
}

function JobDetailsView({ run }: { run: Run }) {
  const [viewMode, setViewMode] = useState<'timeline' | 'table'>('timeline');
  const [sortField, setSortField] = useState<JobSortField>('duration');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  if (!run.jobs || run.jobs.length === 0) {
    return <div className="p-8 text-neutral-500 dark:text-neutral-400 text-center text-sm">No jobs found for this workflow.</div>;
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
    <div className="px-6 py-4 border-l-4 border-blue-500 dark:border-blue-400 bg-white dark:bg-neutral-900">
      <div className="flex justify-between items-center mb-4">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">Job Execution Details</h4>
        <div className="flex bg-neutral-100 dark:bg-neutral-800 p-1 rounded-lg">
          <button
            onClick={() => setViewMode('timeline')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors ${
              viewMode === 'timeline'
                ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-900 dark:text-neutral-100'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            }`}
          >
            <AlignLeft className="w-3.5 h-3.5" /> Timeline
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors ${
              viewMode === 'table'
                ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-900 dark:text-neutral-100'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            }`}
          >
            <LayoutList className="w-3.5 h-3.5" /> Table
          </button>
        </div>
      </div>

      {viewMode === 'timeline' ? (
        <div className="space-y-3">
          <div className="flex text-[10px] text-neutral-400 dark:text-neutral-500 font-mono justify-between mb-2 px-2">
            <span>0s</span>
            <span>{formatDuration(totalMs / 1000)}</span>
          </div>
          {run.jobs.map((job) => {
            const startMs = new Date(job.created_at || job.started_at || 0).getTime();
            const queueWidth = (job.queueDurationInSeconds * 1000 / totalMs) * 100;
            const runWidth = (job.durationInSeconds * 1000 / totalMs) * 100;
            const leftOffset = ((startMs - minTime) / totalMs) * 100;

            return (
              <div key={job.id} className="relative h-8 bg-neutral-100 dark:bg-neutral-800 rounded-md overflow-hidden group flex items-center">
                <div
                  className="absolute h-full bg-amber-200/50 border-y border-l border-amber-300/50"
                  style={{ left: `${leftOffset}%`, width: `${Math.max(0.5, queueWidth)}%` }}
                />
                <div
                  className={`absolute h-full border ${
                    job.conclusion === 'success'
                      ? 'bg-green-500 border-green-600'
                      : job.conclusion === 'skipped'
                        ? 'bg-neutral-400 border-neutral-500'
                        : 'bg-red-500 border-red-600'
                  }`}
                  style={{ left: `${leftOffset + queueWidth}%`, width: `${Math.max(0.5, runWidth)}%` }}
                />
                <div className="relative z-10 px-3 text-xs font-medium text-neutral-800 dark:text-neutral-200 drop-shadow-sm flex justify-between w-full truncate pointer-events-none">
                  <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="hover:underline truncate max-w-[60%] pointer-events-auto">
                    {job.name}
                  </a>
                  <span className="text-neutral-600 dark:text-neutral-400 font-mono opacity-0 group-hover:opacity-100 transition-opacity bg-white dark:bg-neutral-900/80 px-1 rounded pointer-events-auto">
                    Q: {formatDuration(job.queueDurationInSeconds)} | R: {formatDuration(job.durationInSeconds)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden border border-neutral-200 dark:border-neutral-700 rounded-lg">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-2 cursor-pointer" onClick={() => handleSort('name')}>Job Name</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 cursor-pointer" onClick={() => handleSort('queue')}>Queue Time</th>
                <th className="px-4 py-2 cursor-pointer" onClick={() => handleSort('duration')}>Run Time</th>
                <th className="px-4 py-2 text-right">Links</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 bg-white dark:bg-neutral-900">
              {sortedJobs.map((job) => (
                <tr key={job.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950">
                  <td className="px-4 py-2.5 font-medium text-neutral-800 dark:text-neutral-200">{job.name}</td>
                  <td className="px-4 py-2.5"><StatusBadge conclusion={job.conclusion} /></td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(job.queueDurationInSeconds)}</td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(job.durationInSeconds)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
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

function DashboardContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialDays = searchParams.get('days') ? parseInt(searchParams.get('days')!, 10) : 7;
  const initialStartDate = searchParams.get('startDate') || '';
  const initialEndDate = searchParams.get('endDate') || '';
  const initialUseCustomRange = searchParams.get('useCustomRange') === 'true';
  const initialFilterName = searchParams.get('filterName') || '';
  const initialRepoKey = searchParams.get('repo') || '';

  const [days, setDays] = useState(initialDays);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [useCustomRange, setUseCustomRange] = useState(initialUseCustomRange);
  const [filterName, setFilterName] = useState(initialFilterName);
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [selectedRepoKey, setSelectedRepoKey] = useState(initialRepoKey);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [prs, setPrs] = useState<PullRequestMetricsSummary[]>([]);
  const [detailsByNumber, setDetailsByNumber] = useState<Record<number, PullRequestDetailFile['pr']>>({});
  const [loadingDetailNumber, setLoadingDetailNumber] = useState<number | null>(null);
  const [expandedPrNumber, setExpandedPrNumber] = useState<number | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<number | null>(null);
  const [workflowSortField, setWorkflowSortField] = useState<WorkflowSortField>('date');
  const [workflowSortOrder, setWorkflowSortOrder] = useState<WorkflowSortOrder>('desc');

  const selectedRepo = useMemo(() => {
    if (repoOptions.length === 0) {
      return null;
    }

    return repoOptions.find((repo) => repo.key === selectedRepoKey) ?? repoOptions[0];
  }, [repoOptions, selectedRepoKey]);

  useEffect(() => {
    let cancelled = false;

    const fetchRepos = async () => {
      try {
        const res = await fetch('/api/repos', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to load repositories: ${res.status}`);
        }

        const data = (await res.json()) as { repos?: RepoOption[] };
        const repos = data.repos ?? [];
        if (cancelled) return;

        setRepoOptions(repos);
        if (repos.length === 0) {
          setError('No repository data found under data/.');
          return;
        }

        if (!initialRepoKey || !repos.some((repo) => repo.key === initialRepoKey)) {
          setSelectedRepoKey(repos[0].key);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load repository list.');
        }
      }
    };

    fetchRepos();

    return () => {
      cancelled = true;
    };
  }, [initialRepoKey]);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      if (!selectedRepo) {
        return;
      }

      setLoading(true);
      setError('');
      setExpandedPrNumber(null);
      setExpandedWorkflowId(null);
      setDetailsByNumber({});

      try {
        const data = await fetchPullRequestIndex(selectedRepo.owner, selectedRepo.repo);
        if (!cancelled) {
          setPrs(data.prs);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PR metrics.');
          setPrs([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [selectedRepo]);

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

  const filteredPrs = useMemo(() => {
    let result = [...prs];

    const hasCustomRange = useCustomRange && startDate && endDate;
    const rangeStart = hasCustomRange ? startOfDay(parseISO(startDate)) : subDays(new Date(), days);
    const rangeEnd = hasCustomRange ? endOfDay(parseISO(endDate)) : new Date();

    result = result.filter((pr) => {
      const createdAt = new Date(pr.created_at);
      return isAfter(createdAt, rangeStart) && isBefore(createdAt, rangeEnd);
    });

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((pr) =>
        `${pr.number} ${pr.title} ${pr.branch} ${pr.author}`.toLowerCase().includes(query)
      );
    }

    return result;
  }, [days, endDate, filterName, prs, startDate, useCustomRange]);

  const totalPrs = filteredPrs.length;
  const mergedPrs = filteredPrs.filter((pr) => pr.merged_at).length;
  const successRate = totalPrs ? Math.round((filteredPrs.filter((pr) => pr.conclusion === 'success').length / totalPrs) * 100) : 0;
  const avgCiDuration = totalPrs
    ? Math.round(filteredPrs.reduce((sum, pr) => sum + (pr.ciDurationInSeconds ?? 0), 0) / totalPrs)
    : 0;

  const chartData = useMemo(
    () =>
      [...filteredPrs]
        .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
        .map((pr) => ({
          name: `#${pr.number}`,
          duration: Math.round((pr.ciDurationInSeconds ?? 0) / 60),
        })),
    [filteredPrs]
  );

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
    const result = [...workflows];
    if (workflowSortOrder === 'none') {
      return result;
    }

    result.sort((left, right) => {
      let comparison = 0;
      if (workflowSortField === 'date') comparison = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
      if (workflowSortField === 'duration') comparison = left.durationInSeconds - right.durationInSeconds;
      if (workflowSortField === 'name') comparison = left.name.localeCompare(right.name);
      return workflowSortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  };

  if (!selectedRepo) {
    return (
      <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <Activity className="w-8 h-8 animate-pulse text-blue-500 dark:text-blue-400" />
          <p>{error || 'Loading tracked repositories...'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 p-4 md:p-8 font-sans text-neutral-900 dark:text-neutral-100 flex flex-col">
      <div className="max-w-6xl mx-auto space-y-6 flex-1 w-full">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="text-blue-500 dark:text-blue-400" />
              Action Insight
            </h1>
            <p className="text-neutral-500 dark:text-neutral-400 text-sm">Monitor PR lifecycle metrics for {selectedRepo.key}</p>
          </div>

          <div className="flex w-full md:w-auto gap-2">
            <button onClick={copyShareLink} title="Copy link to current view" className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 p-2 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors flex items-center justify-center">
              <Share2 className="w-5 h-5" />
            </button>
            <a href="https://github.com/pkking/action-insight/issues/new/choose" target="_blank" rel="noopener noreferrer" title="Give Feedback / Report Bug" className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 p-2 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors flex items-center justify-center">
              <MessageSquare className="w-5 h-5" />
            </a>
          </div>
        </header>

        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex items-center gap-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2">
            <label htmlFor="repo-select" className="text-sm text-neutral-500 dark:text-neutral-400 whitespace-nowrap">Repo</label>
            <select id="repo-select" value={selectedRepo.key} onChange={(event) => setSelectedRepoKey(event.target.value)} className="bg-transparent text-sm text-neutral-700 dark:text-neutral-300 outline-none min-w-56">
              {repoOptions.map((repo) => (
                <option key={repo.key} value={repo.key}>{repo.key}</option>
              ))}
            </select>
          </div>

          {[7, 30, 90].map((value) => (
            <button
              key={value}
              onClick={() => {
                setUseCustomRange(false);
                setDays(value);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                days === value && !useCustomRange
                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800'
                  : 'bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-950'
              }`}
            >
              Last {value} Days
            </button>
          ))}

          <button
            onClick={() => setUseCustomRange(true)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
              useCustomRange
                ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800'
                : 'bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-950'
            }`}
          >
            <CalendarIcon className="w-4 h-4" />
            Custom
          </button>

          {useCustomRange && (
            <div className="flex items-center gap-2 bg-white dark:bg-neutral-900 p-1 rounded-lg border border-neutral-200 dark:border-neutral-700">
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="bg-transparent text-sm border-none focus:ring-0 text-neutral-700 dark:text-neutral-300 px-2 py-1 outline-none" />
              <span className="text-neutral-400">-</span>
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="bg-transparent text-sm border-none focus:ring-0 text-neutral-700 dark:text-neutral-300 px-2 py-1 outline-none" />
            </div>
          )}
        </div>

        {error ? (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 p-4 rounded-lg border border-red-100 dark:border-red-800">{error}</div>
        ) : loading ? (
          <div className="flex items-center justify-center h-64 text-neutral-400 dark:text-neutral-500 flex-col gap-4">
            <Activity className="w-8 h-8 animate-pulse text-blue-500 dark:text-blue-400" />
            <p className="text-sm">Fetching PR metrics for {selectedRepo.key}...</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full"><Activity className="w-6 h-6" /></div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Total PRs</p>
                  <p className="text-2xl font-bold">{totalPrs}</p>
                </div>
              </div>
              <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4">
                <div className="p-3 bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full"><CheckCircle className="w-6 h-6" /></div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Merged PRs</p>
                  <p className="text-2xl font-bold">{mergedPrs}</p>
                </div>
              </div>
              <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4">
                <div className="p-3 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-full"><Clock className="w-6 h-6" /></div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Avg CI Duration</p>
                  <p className="text-2xl font-bold">{formatDuration(avgCiDuration)}</p>
                </div>
              </div>
            </div>

            <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold flex items-center gap-2"><CalendarIcon className="w-5 h-5 text-neutral-400 dark:text-neutral-500" /> PR CI Duration Trend (Minutes)</h2>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">CI success rate: {successRate}%</div>
              </div>
              <div className="h-72 select-none">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" className="dark:opacity-20" />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis tick={{ fontSize: 12, fill: '#888' }} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="duration" stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{ r: 6 }} animationDuration={300} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 overflow-hidden">
              <div className="p-6 border-b border-neutral-100 dark:border-neutral-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h2 className="text-lg font-bold">PR Lifecycle</h2>
                <div className="flex items-center gap-2 bg-neutral-50 dark:bg-neutral-950 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm">
                  <Filter className="w-4 h-4 text-neutral-400 dark:text-neutral-500" />
                  <input type="text" placeholder="Filter by PR, title, branch..." value={filterName} onChange={(event) => setFilterName(event.target.value)} className="bg-transparent border-none outline-none w-48" />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-950 text-neutral-500 dark:text-neutral-400 font-medium">
                    <tr>
                      <th className="py-3 px-6">PR / Branch</th>
                      <th className="py-3 px-6">Status</th>
                      <th className="py-3 px-6">T1 PR Created</th>
                      <th className="py-3 px-6">T2 CI Started</th>
                      <th className="py-3 px-6">T3 CI Completed</th>
                      <th className="py-3 px-6">T4 PR Merged</th>
                      <th className="py-3 px-6">Submit→CI Start</th>
                      <th className="py-3 px-6">CI Start→CI End</th>
                      <th className="py-3 px-6">Submit→Merge</th>
                      <th className="py-3 px-6 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {filteredPrs.map((pr) => {
                      const detail = detailsByNumber[pr.number];
                      const workflows = detail ? getSortedWorkflows(detail.workflows) : [];

                      return (
                        <React.Fragment key={pr.number}>
                          <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                            <td className="py-4 px-6">
                              <div className="font-medium text-neutral-900 dark:text-neutral-100">PR #{pr.number}</div>
                              <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{pr.title}</div>
                              <div className="text-xs mt-1 font-mono text-neutral-500 dark:text-neutral-400">{pr.branch}</div>
                            </td>
                            <td className="py-4 px-6"><StatusBadge conclusion={pr.conclusion} /></td>
                            <td className="py-4 px-6 text-neutral-500 dark:text-neutral-400">{format(new Date(pr.created_at), 'MMM dd, HH:mm')}</td>
                            <td className="py-4 px-6 text-neutral-500 dark:text-neutral-400">{pr.ci_started_at ? format(new Date(pr.ci_started_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                            <td className="py-4 px-6 text-neutral-500 dark:text-neutral-400">{pr.ci_completed_at ? format(new Date(pr.ci_completed_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                            <td className="py-4 px-6 text-neutral-500 dark:text-neutral-400">{pr.merged_at ? format(new Date(pr.merged_at), 'MMM dd, HH:mm') : 'N/A'}</td>
                            <td className="py-4 px-6 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(pr.timeToCiStartInSeconds)}</td>
                            <td className="py-4 px-6 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(pr.ciDurationInSeconds)}</td>
                            <td className="py-4 px-6 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(pr.timeToMergeInSeconds)}</td>
                            <td className="py-4 px-6 text-right">
                              <button onClick={() => void loadDetail(pr.number)} className="inline-flex items-center gap-1 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                                {expandedPrNumber === pr.number ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                {loadingDetailNumber === pr.number ? 'Loading...' : 'Workflows'}
                              </button>
                              <a href={pr.html_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 ml-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 p-1.5" title="View PR on GitHub">
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            </td>
                          </tr>

                          {expandedPrNumber === pr.number && detail && (
                            <tr className="bg-neutral-50 dark:bg-neutral-950/50">
                              <td colSpan={10} className="p-0">
                                <div className="px-6 py-4 border-l-4 border-blue-500 dark:border-blue-400 bg-white dark:bg-neutral-900">
                                  <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-5">
                                    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">T1 PR Created</div>
                                      <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{format(new Date(detail.created_at), 'MMM dd, HH:mm')}</div>
                                    </div>
                                    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">T2 CI Started</div>
                                      <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{detail.ci_started_at ? format(new Date(detail.ci_started_at), 'MMM dd, HH:mm') : 'N/A'}</div>
                                    </div>
                                    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">T3 CI Completed</div>
                                      <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{detail.ci_completed_at ? format(new Date(detail.ci_completed_at), 'MMM dd, HH:mm') : 'N/A'}</div>
                                    </div>
                                    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">T4 PR Merged</div>
                                      <div className="mt-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">{detail.merged_at ? format(new Date(detail.merged_at), 'MMM dd, HH:mm') : 'N/A'}</div>
                                    </div>
                                    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-900/20 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Submit→CI Start</div>
                                      <div className="mt-2 text-sm font-mono font-medium text-neutral-900 dark:text-neutral-100">{formatDuration(detail.timeToCiStartInSeconds)}</div>
                                    </div>
                                    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/80 dark:bg-blue-900/20 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">CI Start→CI End</div>
                                      <div className="mt-2 text-sm font-mono font-medium text-neutral-900 dark:text-neutral-100">{formatDuration(detail.ciDurationInSeconds)}</div>
                                    </div>
                                    <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-900/20 p-3">
                                      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Submit→Merge</div>
                                      <div className="mt-2 text-sm font-mono font-medium text-neutral-900 dark:text-neutral-100">{formatDuration(detail.timeToMergeInSeconds)}</div>
                                    </div>
                                  </div>

                                  <div className="flex items-center justify-between mb-4 gap-4">
                                    <div>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <h3 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">Workflows for PR #{pr.number}</h3>
                                        {detail.partialCiHistory && (
                                          <span className="inline-flex items-center rounded-full border border-amber-300/60 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                            Partial CI history
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Select a workflow to inspect its jobs.</p>
                                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{detail.successfulWorkflowCount} / {detail.workflowCount} successful workflows</p>
                                    </div>
                                    <div className="flex gap-2 text-xs">
                                      <button onClick={() => toggleWorkflowSort('name')} className="px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800">Sort: Name</button>
                                      <button onClick={() => toggleWorkflowSort('duration')} className="px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800">Sort: Duration</button>
                                      <button onClick={() => toggleWorkflowSort('date')} className="px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800">Sort: Date</button>
                                    </div>
                                  </div>

                                  <div className="overflow-hidden border border-neutral-200 dark:border-neutral-700 rounded-lg">
                                    <table className="w-full text-left text-sm">
                                      <thead className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
                                        <tr>
                                          <th className="px-4 py-2">Workflow</th>
                                          <th className="px-4 py-2">Status</th>
                                          <th className="px-4 py-2">Duration</th>
                                          <th className="px-4 py-2">Started</th>
                                          <th className="px-4 py-2 text-right">Details</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 bg-white dark:bg-neutral-900">
                                        {workflows.map((workflow) => (
                                          <React.Fragment key={workflow.id}>
                                            <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50">
                                              <td className="px-4 py-3 font-medium text-neutral-800 dark:text-neutral-200">{workflow.name}</td>
                                              <td className="px-4 py-3"><StatusBadge conclusion={workflow.conclusion} /></td>
                                              <td className="px-4 py-3 font-mono text-neutral-600 dark:text-neutral-400">{formatDuration(workflow.durationInSeconds)}</td>
                                              <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{format(new Date(workflow.created_at), 'MMM dd, HH:mm')}</td>
                                              <td className="px-4 py-3 text-right">
                                                <button onClick={() => setExpandedWorkflowId(expandedWorkflowId === workflow.id ? null : workflow.id)} className="inline-flex items-center gap-1 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                                                  {expandedWorkflowId === workflow.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                  Jobs
                                                </button>
                                                <a href={workflow.html_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 ml-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 p-1.5" title="View workflow on GitHub">
                                                  <ExternalLink className="w-4 h-4" />
                                                </a>
                                              </td>
                                            </tr>
                                            {expandedWorkflowId === workflow.id && (
                                              <tr className="bg-neutral-50 dark:bg-neutral-950/50">
                                                <td colSpan={5} className="p-0"><JobDetailsView run={workflow} /></td>
                                              </tr>
                                            )}
                                          </React.Fragment>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}

                    {filteredPrs.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-8 text-center text-neutral-500 dark:text-neutral-400">No matching PRs found for {selectedRepo.key}. Try adjusting the date range or filter.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center"><Activity className="w-8 h-8 animate-pulse text-blue-500 dark:text-blue-400" /></div>}>
      <DashboardContent />
    </Suspense>
  );
}
