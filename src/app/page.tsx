'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Activity, CheckCircle, XCircle, Clock, Calendar as CalendarIcon, ExternalLink, ChevronDown, ChevronUp, Filter, ArrowUpDown, ArrowDown, ArrowUp, Share2, Info, MessageSquare, LayoutList, AlignLeft, RefreshCw } from 'lucide-react';
import { 
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceArea
} from 'recharts';
import { format, subDays, isAfter, isBefore, startOfDay, endOfDay, parseISO } from 'date-fns';
import { fetchRuns } from '@/lib/data-fetcher';
import type { Run as BaseRun } from '@/lib/types';

type Run = BaseRun & { jobsLoading?: boolean };

type SortField = 'date' | 'duration' | 'name';
type SortOrder = 'asc' | 'desc' | 'none';
type JobSortField = 'queue' | 'duration' | 'name';

function JobDetailsView({ run }: { run: Run }) {
  const [viewMode, setViewMode] = useState<'timeline' | 'table'>('timeline');
  const [sortField, setSortField] = useState<JobSortField>('duration');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  if (run.jobsLoading) {
    return <div className="p-8 flex justify-center"><Activity className="w-6 h-6 animate-spin text-blue-500 dark:text-blue-400" /></div>;
  }
  
  if (!run.jobs || run.jobs.length === 0) {
    return <div className="p-8 text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 text-center text-sm">No jobs found for this run.</div>;
  }

  const formatDur = (seconds: number) => {
    if (seconds < 1) return '< 1s';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  };

  // Sort logic for table
  const sortedJobs = [...run.jobs].sort((a, b) => {
    let comp = 0;
    if (sortField === 'name') comp = a.name.localeCompare(b.name);
    else if (sortField === 'duration') comp = a.durationInSeconds - b.durationInSeconds;
    else if (sortField === 'queue') comp = a.queueDurationInSeconds - b.queueDurationInSeconds;
    return sortOrder === 'asc' ? comp : -comp;
  });

  const handleSort = (field: JobSortField) => {
    if (sortField === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Timeline / Gantt logic
  const minTime = Math.min(...run.jobs.map(j => new Date(j.created_at || j.started_at || 0).getTime()));
  const maxTime = Math.max(...run.jobs.map(j => new Date(j.completed_at || j.started_at || new Date().toISOString()).getTime()));
  const totalMs = Math.max(1000, maxTime - minTime);

  return (
    <div className="px-6 py-4 border-l-4 border-blue-500 dark:border-blue-400 bg-white dark:bg-neutral-900 dark:bg-neutral-100/50">
      <div className="flex justify-between items-center mb-4">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 flex items-center gap-2">
          Job Execution Details
        </h4>
        <div className="flex bg-neutral-100 dark:bg-neutral-800 p-1 rounded-lg">
          <button 
            onClick={() => setViewMode('timeline')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors ${viewMode === 'timeline' ? 'bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500'}`}
          >
            <AlignLeft className="w-3.5 h-3.5" /> Timeline
          </button>
          <button 
            onClick={() => setViewMode('table')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors ${viewMode === 'table' ? 'bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 shadow-sm text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500'}`}
          >
            <LayoutList className="w-3.5 h-3.5" /> Table
          </button>
        </div>
      </div>

      {viewMode === 'timeline' ? (
        <div className="space-y-3">
          <div className="flex text-[10px] text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 font-mono justify-between mb-2 px-2">
            <span>0s</span>
            <span>{formatDur(totalMs / 1000)}</span>
          </div>
          {run.jobs.map(job => {
            const startMs = new Date(job.created_at || job.started_at || 0).getTime();
            const queueWidth = (job.queueDurationInSeconds * 1000 / totalMs) * 100;
            const runWidth = (job.durationInSeconds * 1000 / totalMs) * 100;
            const leftOffset = ((startMs - minTime) / totalMs) * 100;
            
            return (
              <div key={job.id} className="relative h-8 bg-neutral-100 dark:bg-neutral-800 rounded-md overflow-hidden group flex items-center">
                <div 
                  className="absolute h-full bg-amber-200/50 border-y border-l border-amber-300/50" 
                  style={{ left: `${leftOffset}%`, width: `${Math.max(0.5, queueWidth)}%` }} 
                  title={`Queued: ${formatDur(job.queueDurationInSeconds)}`}
                />
                <div 
                  className={`absolute h-full border ${job.conclusion === 'success' ? 'bg-green-500 border-green-600' : job.conclusion === 'skipped' ? 'bg-neutral-400 border-neutral-500' : 'bg-red-500 border-red-600'}`} 
                  style={{ left: `${leftOffset + queueWidth}%`, width: `${Math.max(0.5, runWidth)}%` }}
                  title={`Ran: ${formatDur(job.durationInSeconds)}`}
                />
                <div className="relative z-10 px-3 text-xs font-medium text-neutral-800 dark:text-neutral-200 drop-shadow-sm flex justify-between w-full truncate pointer-events-none">
                  <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="hover:underline truncate max-w-[60%] pointer-events-auto">
                    {job.name}
                  </a>
                  <span className="text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 font-mono opacity-0 group-hover:opacity-100 transition-opacity bg-white dark:bg-neutral-900 dark:bg-neutral-100/80 px-1 rounded pointer-events-auto">
                    Q: {formatDur(job.queueDurationInSeconds)} | R: {formatDur(job.durationInSeconds)}
                  </span>
                </div>
              </div>
            );
          })}
          <div className="flex gap-4 mt-4 text-xs text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 justify-end">
            <span className="flex items-center gap-1.5"><div className="w-3 h-3 bg-amber-200/50 border border-amber-300/50 rounded-sm"></div> Queue Time</span>
            <span className="flex items-center gap-1.5"><div className="w-3 h-3 bg-green-500 rounded-sm"></div> Run Time (Success)</span>
            <span className="flex items-center gap-1.5"><div className="w-3 h-3 bg-red-500 rounded-sm"></div> Run Time (Failed)</span>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden border border-neutral-200 dark:border-neutral-700 rounded-lg">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">
              <tr>
                <th className="px-4 py-2 cursor-pointer hover:bg-neutral-200 dark:bg-neutral-700 transition-colors" onClick={() => handleSort('name')}>
                  <div className="flex items-center gap-1">Job Name {sortField === 'name' && (sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}</div>
                </th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 cursor-pointer hover:bg-neutral-200 dark:bg-neutral-700 transition-colors" onClick={() => handleSort('queue')}>
                  <div className="flex items-center gap-1">Queue Time {sortField === 'queue' && (sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}</div>
                </th>
                <th className="px-4 py-2 cursor-pointer hover:bg-neutral-200 dark:bg-neutral-700 transition-colors" onClick={() => handleSort('duration')}>
                  <div className="flex items-center gap-1">Run Time {sortField === 'duration' && (sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}</div>
                </th>
                <th className="px-4 py-2 text-right">Links</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800">
              {sortedJobs.map(job => (
                <tr key={job.id} className="hover:bg-neutral-50 dark:bg-neutral-950">
                  <td className="px-4 py-2.5 font-medium text-neutral-800 dark:text-neutral-200">{job.name}</td>
                  <td className="px-4 py-2.5">
                    {job.conclusion === 'success' ? <span className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Success</span> :
                     job.conclusion === 'skipped' ? <span className="text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 flex items-center gap-1"><Info className="w-3 h-3" /> Skipped</span> :
                     <span className="text-red-600 dark:text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" /> {job.conclusion || 'Failed'}</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">{formatDur(job.queueDurationInSeconds)}</td>
                  <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">{formatDur(job.durationInSeconds)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Logs</a>
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

  // Read initial state from URL parameters
  const initialDays = searchParams.get('days') ? parseInt(searchParams.get('days')!) : 7;
  const initialStartDate = searchParams.get('startDate') || '';
  const initialEndDate = searchParams.get('endDate') || '';
  const initialUseCustomRange = searchParams.get('useCustomRange') === 'true';
  const initialSortField = (searchParams.get('sortField') as SortField) || 'date';
  const initialSortOrder = (searchParams.get('sortOrder') as SortOrder) || 'desc';
  const initialFilterName = searchParams.get('filterName') || '';
  const initialMinDuration = searchParams.get('minDuration') || '';
  const initialMaxDuration = searchParams.get('maxDuration') || '';

  const [days, setDays] = useState(initialDays);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [useCustomRange, setUseCustomRange] = useState(initialUseCustomRange);
  
  // Filters and Sorting
  const [filterName, setFilterName] = useState(initialFilterName);
  const [minDuration, setMinDuration] = useState(initialMinDuration);
  const [maxDuration, setMaxDuration] = useState(initialMaxDuration);
  const [sortField, setSortField] = useState<SortField>(initialSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);

  // Time Zoom (Brush) State
  const [zoomLeft, setZoomLeft] = useState<string | null>(null);
  const [zoomRight, setZoomRight] = useState<string | null>(null);
  const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<string | null>(null);

  // Data fetching state
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);

  // Fetch data from pre-collected JSON files
  useEffect(() => {
    let isCancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setLoadingProgress(0);
      setError('');
      setRuns([]);
      
      try {
        const runs = await fetchRuns('vllm-project', 'vllm-ascend', days);
        
        if (!isCancelled) {
          const isCustomValid = useCustomRange && startDate && endDate;
          const cutoffDate = isCustomValid ? startOfDay(parseISO(startDate)) : subDays(new Date(), days);
          const endCutoffDate = isCustomValid ? endOfDay(parseISO(endDate)) : new Date();
          
          const filteredRuns = runs.filter(r => 
            isAfter(new Date(r.created_at), cutoffDate) && 
            isBefore(new Date(r.created_at), endCutoffDate)
          );
          
          setRuns(filteredRuns);
          setLoadingProgress(100);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('Failed to load data. ETL may not have run yet.');
          }
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
          setTimeout(() => {
            if (!isCancelled) setLoadingProgress(0);
          }, 500);
        }
      }
    };
    
    fetchData();
    
    return () => {
      isCancelled = true;
    };
  }, [days, useCustomRange, startDate, endDate]);

  // Sync state changes back to URL
  useEffect(() => {
    const params = new URLSearchParams();
    
    if (useCustomRange) {
      params.set('useCustomRange', 'true');
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
    } else if (days !== 7) {
      params.set('days', days.toString());
    }
    if (filterName) params.set('filterName', filterName);
    if (minDuration) params.set('minDuration', minDuration);
    if (maxDuration) params.set('maxDuration', maxDuration);
    if (sortField !== 'date') params.set('sortField', sortField);
    if (sortOrder !== 'desc') params.set('sortOrder', sortOrder);

    const query = params.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    
    router.replace(url, { scroll: false });
  }, [days, useCustomRange, startDate, endDate, filterName, minDuration, maxDuration, sortField, sortOrder, pathname, router]);

  useEffect(() => {
    setZoomLeft(null);
    setZoomRight(null);
  }, [days]);

  const fetchJobsForRun = async (runId: number) => {
    setExpandedRunId(expandedRunId === runId ? null : runId);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortOrder === 'desc') setSortOrder('asc');
      else if (sortOrder === 'asc') setSortOrder('none');
      else setSortOrder('desc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Base Data for Chart (All loaded runs)
  const baseChartData = useMemo(() => {
    return [...runs].reverse().map(r => ({
      name: format(new Date(r.created_at), 'MMM dd HH:mm'),
      rawDate: r.created_at,
      duration: Math.round(r.durationInSeconds / 60), // in minutes
      success: r.conclusion === 'success' ? 1 : 0
    }));
  }, [runs]);

  // Chart Zoom Handler
  const zoom = () => {
    if (refAreaLeft === refAreaRight || refAreaRight === null || refAreaLeft === null) {
      setRefAreaLeft(null);
      setRefAreaRight(null);
      return;
    }

    // Determine left and right based on array index to handle dragging backwards
    const idxLeft = baseChartData.findIndex(d => d.name === refAreaLeft);
    const idxRight = baseChartData.findIndex(d => d.name === refAreaRight);
    
    if (idxLeft > idxRight) {
      setZoomLeft(refAreaRight);
      setZoomRight(refAreaLeft);
    } else {
      setZoomLeft(refAreaLeft);
      setZoomRight(refAreaRight);
    }

    setRefAreaLeft(null);
    setRefAreaRight(null);
  };

  const zoomOut = () => {
    setZoomLeft(null);
    setZoomRight(null);
  };

  // The actual data displayed on the chart based on zoom
  const currentChartData = useMemo(() => {
    if (zoomLeft && zoomRight) {
      const idxLeft = baseChartData.findIndex(d => d.name === zoomLeft);
      const idxRight = baseChartData.findIndex(d => d.name === zoomRight);
      if (idxLeft !== -1 && idxRight !== -1) {
        return baseChartData.slice(idxLeft, idxRight + 1);
      }
    }
    return baseChartData;
  }, [baseChartData, zoomLeft, zoomRight]);

  // Filtered runs incorporating Chart Zoom time bounds + Search/Sort Filters
  const filteredAndSortedRuns = useMemo(() => {
    let result = [...runs];

    // 1. Time Zoom Filter (If user zoomed the chart, filter table & stats to that exact time span)
    if (zoomLeft && zoomRight) {
      const leftData = baseChartData.find(d => d.name === zoomLeft);
      const rightData = baseChartData.find(d => d.name === zoomRight);
      if (leftData && rightData) {
        const leftDate = new Date(leftData.rawDate);
        const rightDate = new Date(rightData.rawDate);
        result = result.filter(r => {
          const d = new Date(r.created_at);
          return d >= leftDate && d <= rightDate;
        });
      }
    }

    // 2. Filter by name
    if (filterName) {
      const lowerQuery = filterName.toLowerCase();
      result = result.filter(r => r.name.toLowerCase().includes(lowerQuery) || r.head_branch.toLowerCase().includes(lowerQuery));
    }

    // 3. Filter by min duration
    if (minDuration) {
      const minSeconds = parseInt(minDuration) * 60;
      if (!isNaN(minSeconds)) {
        result = result.filter(r => r.durationInSeconds >= minSeconds);
      }
    }

    // 4. Filter by max duration
    if (maxDuration) {
      const maxSeconds = parseInt(maxDuration) * 60;
      if (!isNaN(maxSeconds)) {
        result = result.filter(r => r.durationInSeconds <= maxSeconds);
      }
    }

    // 5. Sort
    if (sortOrder !== 'none') {
      result.sort((a, b) => {
        let comparison = 0;
        if (sortField === 'date') {
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        } else if (sortField === 'duration') {
          comparison = a.durationInSeconds - b.durationInSeconds;
        } else if (sortField === 'name') {
          comparison = a.name.localeCompare(b.name);
        }
        return sortOrder === 'asc' ? comparison : -comparison;
      });
    }

    return result;
  }, [runs, filterName, minDuration, maxDuration, sortField, sortOrder, zoomLeft, zoomRight, baseChartData]);

  // Stats calculation (based on Zoomed/Filtered runs!)
  const totalRuns = filteredAndSortedRuns.length;
  const successfulRuns = filteredAndSortedRuns.filter(r => r.conclusion === 'success').length;
  const successRate = totalRuns ? Math.round((successfulRuns / totalRuns) * 100) : 0;
  const avgDuration = totalRuns ? Math.round(filteredAndSortedRuns.reduce((acc, r) => acc + r.durationInSeconds, 0) / totalRuns) : 0;

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field || sortOrder === 'none') {
      return <ArrowUpDown className="w-3 h-3 text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500" />;
    }
    return sortOrder === 'desc' 
      ? <ArrowDown className="w-3 h-3 text-blue-500 dark:text-blue-400" />
      : <ArrowUp className="w-3 h-3 text-blue-500 dark:text-blue-400" />;
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    alert('Shareable link copied to clipboard!');
  };

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 p-4 md:p-8 font-sans text-neutral-900 dark:text-neutral-100 flex flex-col">
      {/* Top Progress Bar */}
      {loadingProgress > 0 && loadingProgress < 100 && (
        <div className="fixed top-0 left-0 w-full h-1 bg-neutral-200 dark:bg-neutral-700 z-50">
          <div 
            className="h-full bg-blue-600 dark:bg-blue-500 transition-all duration-300 ease-out"
            style={{ width: `${loadingProgress}%` }}
          />
        </div>
      )}

      <div className="max-w-6xl mx-auto space-y-6 flex-1 w-full">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="text-blue-500 dark:text-blue-400" />
              Action Insight
            </h1>
            <p className="text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 text-sm">Monitor GitHub Actions CI/CD metrics</p>
          </div>
          
          <div className="flex w-full md:w-auto gap-2">
            <button 
              onClick={copyShareLink}
              title="Copy link to current view"
              className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 p-2 rounded-lg hover:bg-neutral-200 dark:bg-neutral-700 transition-colors flex items-center justify-center"
            >
              <Share2 className="w-5 h-5" />
            </button>
            <a 
              href="https://github.com/pkking/action-insight/issues/new/choose" 
              target="_blank"
              rel="noopener noreferrer"
              title="Give Feedback / Report Bug"
              className="bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 p-2 rounded-lg hover:bg-neutral-200 dark:bg-neutral-700 transition-colors flex items-center justify-center"
            >
              <MessageSquare className="w-5 h-5" />
            </a>
          </div>
        </header>

        {/* Controls */}
        <div className="flex gap-2 items-center flex-wrap">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => { setUseCustomRange(false); setDays(d); }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                days === d && !useCustomRange && !zoomLeft // Highlighting only if no custom zoom is active
                ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800' 
                : 'bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:bg-neutral-950'
              }`}
            >
              Last {d} Days
            </button>
          ))}
          <button
            onClick={() => setUseCustomRange(true)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
              useCustomRange
              ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800' 
              : 'bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:bg-neutral-950'
            }`}
          >
            <CalendarIcon className="w-4 h-4" />
            Custom
          </button>
          
          {useCustomRange && (
            <div className="flex items-center gap-2 bg-white dark:bg-neutral-900 p-1 rounded-lg border border-neutral-200 dark:border-neutral-700">
              <input 
                type="date" 
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-transparent text-sm border-none focus:ring-0 text-neutral-700 dark:text-neutral-300 px-2 py-1 outline-none"
              />
              <span className="text-neutral-400">-</span>
              <input 
                type="date" 
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-transparent text-sm border-none focus:ring-0 text-neutral-700 dark:text-neutral-300 px-2 py-1 outline-none"
              />
            </div>
          )}
          {loading && runs.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 ml-auto">
              <Activity className="w-4 h-4 animate-spin" />
              Loading older runs...
            </div>
          )}
        </div>

        {error ? (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 p-4 rounded-lg border border-red-100 dark:border-red-800">
            {error}
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 flex-col gap-4">
            <Activity className="w-8 h-8 animate-pulse text-blue-500 dark:text-blue-400" />
            <p className="text-sm">Fetching runs (this may take a moment for larger timeframes)...</p>
          </div>
        ) : (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4 transition-all duration-300">
                <div className="p-3 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full">
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">Total Runs</p>
                  <p className="text-2xl font-bold">{totalRuns}</p>
                </div>
              </div>
              
              <div className="bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4 transition-all duration-300">
                <div className={`p-3 rounded-full ${successRate >= 80 ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400'}`}>
                  {successRate >= 80 ? <CheckCircle className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">Success Rate</p>
                  <p className="text-2xl font-bold">{successRate}%</p>
                </div>
              </div>

              <div className="bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 flex items-center gap-4 transition-all duration-300">
                <div className="p-3 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-full">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">Avg Duration</p>
                  <p className="text-2xl font-bold">{formatDuration(avgDuration)}</p>
                </div>
              </div>
            </div>

            {/* Charts */}
            <div className="bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 p-6 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5 text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500" /> 
                  Duration Trend (Minutes)
                  <span className="text-xs font-normal text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 ml-2">(Drag to zoom)</span>
                </h2>
                {zoomLeft && (
                  <button 
                    onClick={zoomOut}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 rounded-md transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Reset Zoom
                  </button>
                )}
              </div>
              <div className="h-72 select-none">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={currentChartData}
                    onMouseDown={(e) => e && setRefAreaLeft(String(e.activeLabel) || null)}
                    onMouseMove={(e) => refAreaLeft && e && setRefAreaRight(String(e.activeLabel) || null)}
                    onMouseUp={zoom}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-neutral-200, #e5e5e5)" className="dark:opacity-20" />
                    <XAxis dataKey="name" tick={{fontSize: 12, fill: '#888'}} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis tick={{fontSize: 12, fill: '#888'}} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                      cursor={{ stroke: '#f3f4f6', strokeWidth: 2 }}
                    />
                    <Line type="monotone" dataKey="duration" stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{ r: 6 }} animationDuration={300} />
                    
                    {refAreaLeft && refAreaRight ? (
                      <ReferenceArea x1={refAreaLeft} x2={refAreaRight} strokeOpacity={0.3} fill="#3b82f6" fillOpacity={0.1} />
                    ) : null}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Detailed Runs with Filters */}
            <div className="bg-white dark:bg-neutral-900 dark:bg-neutral-100 dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-800 overflow-hidden">
              <div className="p-6 border-b border-neutral-100 dark:border-neutral-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Detailed Runs & Jobs</h2>
                
                <div className="flex flex-wrap gap-3 items-center text-sm">
                  <div className="flex items-center gap-2 bg-neutral-50 dark:bg-neutral-950 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700">
                    <Filter className="w-4 h-4 text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500" />
                    <input 
                      type="text"
                      placeholder="Filter by name..."
                      value={filterName}
                      onChange={e => setFilterName(e.target.value)}
                      className="bg-transparent border-none outline-none w-32 focus:w-40 transition-all"
                    />
                  </div>
                  
                  <div className="flex items-center gap-2 bg-neutral-50 dark:bg-neutral-950 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700">
                    <Clock className="w-4 h-4 text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500" />
                    <input 
                      type="number"
                      placeholder="Min (m)"
                      value={minDuration}
                      onChange={e => setMinDuration(e.target.value)}
                      className="bg-transparent border-none outline-none w-16"
                    />
                    <span className="text-neutral-300 dark:text-neutral-600 dark:text-neutral-400 dark:text-neutral-500">-</span>
                    <input 
                      type="number"
                      placeholder="Max (m)"
                      value={maxDuration}
                      onChange={e => setMaxDuration(e.target.value)}
                      className="bg-transparent border-none outline-none w-16"
                    />
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-950 text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 font-medium">
                    <tr>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 dark:text-neutral-100 select-none group" onClick={() => handleSort('name')}>
                        <div className="flex items-center gap-1">
                          Workflow / Branch {getSortIcon('name')}
                        </div>
                      </th>
                      <th className="py-3 px-6">Status</th>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 dark:text-neutral-100 select-none group" onClick={() => handleSort('duration')}>
                        <div className="flex items-center gap-1">
                          Duration {getSortIcon('duration')}
                        </div>
                      </th>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 dark:text-neutral-100 select-none group" onClick={() => handleSort('date')}>
                        <div className="flex items-center gap-1">
                          Date {getSortIcon('date')}
                        </div>
                      </th>
                      <th className="py-3 px-6 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {filteredAndSortedRuns.map(run => (
                      <React.Fragment key={run.id}>
                        <tr className="hover:bg-neutral-50 dark:bg-neutral-950/50 transition-colors">
                          <td className="py-4 px-6">
                            <div className="font-medium text-neutral-900 dark:text-neutral-100">{run.name}</div>
                            <div className="text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 text-xs mt-1 font-mono">{run.head_branch}</div>
                          </td>
                          <td className="py-4 px-6">
                            {run.conclusion === 'success' ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200/50 dark:border-green-800/50">
                                <CheckCircle className="w-3.5 h-3.5" /> Success
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200/50 dark:border-red-800/50">
                                <XCircle className="w-3.5 h-3.5" /> {run.conclusion || 'Failed'}
                              </span>
                            )}
                          </td>
                          <td className="py-4 px-6 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 font-mono">
                            {formatDuration(run.durationInSeconds)}
                          </td>
                          <td className="py-4 px-6 text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">
                            {format(new Date(run.created_at), 'MMM dd, HH:mm')}
                          </td>
                          <td className="py-4 px-6 text-right">
                            <button 
                              onClick={() => fetchJobsForRun(run.id)}
                              className="inline-flex items-center gap-1 text-neutral-600 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:text-neutral-100 px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:bg-neutral-800 transition-colors"
                            >
                              {expandedRunId === run.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              Jobs
                            </button>
                            <a 
                              href={run.html_url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 ml-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:text-blue-400 p-1.5"
                              title="View on GitHub"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          </td>
                        </tr>
                        
                        {/* Expandable Jobs Section */}
                        {expandedRunId === run.id && (
                          <tr className="bg-neutral-50 dark:bg-neutral-950/50">
                            <td colSpan={5} className="p-0">
                              <JobDetailsView run={run} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                    {filteredAndSortedRuns.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-neutral-500 dark:text-neutral-400 dark:text-neutral-500 dark:text-neutral-400 dark:text-neutral-500">
                          No matching runs found. Try adjusting your filters.
                        </td>
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
    <Suspense fallback={<div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center">
      <Activity className="w-8 h-8 animate-pulse text-blue-500 dark:text-blue-400" />
    </div>}>
      <DashboardContent />
    </Suspense>
  );
}
