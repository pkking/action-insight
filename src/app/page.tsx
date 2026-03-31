'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Search, Activity, CheckCircle, XCircle, Clock, Calendar as CalendarIcon, ExternalLink, ChevronDown, ChevronUp, Filter, ArrowUpDown, ArrowDown, ArrowUp, Share2 } from 'lucide-react';
import { 
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line
} from 'recharts';
import { format, subDays, isAfter } from 'date-fns';

type Job = {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  html_url: string;
  durationInSeconds: number;
};

type Run = {
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
  jobsLoading?: boolean;
};

type SortField = 'date' | 'duration' | 'name';
type SortOrder = 'asc' | 'desc' | 'none';

function DashboardContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read initial state from URL parameters
  const initialRepo = searchParams.get('repo') || 'vercel/next.js';
  const initialDays = searchParams.get('days') ? parseInt(searchParams.get('days')!) : 7;
  const initialSortField = (searchParams.get('sortField') as SortField) || 'date';
  const initialSortOrder = (searchParams.get('sortOrder') as SortOrder) || 'desc';
  const initialFilterName = searchParams.get('filterName') || '';
  const initialMinDuration = searchParams.get('minDuration') || '';
  const initialMaxDuration = searchParams.get('maxDuration') || '';

  const [repoInput, setRepoInput] = useState(initialRepo);
  const [currentRepo, setCurrentRepo] = useState(initialRepo);
  const [days, setDays] = useState(initialDays);
  
  // Filters and Sorting
  const [filterName, setFilterName] = useState(initialFilterName);
  const [minDuration, setMinDuration] = useState(initialMinDuration);
  const [maxDuration, setMaxDuration] = useState(initialMaxDuration);
  const [sortField, setSortField] = useState<SortField>(initialSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);

  // Data fetching state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);

  // Sync state changes back to URL
  useEffect(() => {
    const params = new URLSearchParams();
    
    if (currentRepo !== 'vercel/next.js') params.set('repo', currentRepo);
    if (days !== 7) params.set('days', days.toString());
    if (filterName) params.set('filterName', filterName);
    if (minDuration) params.set('minDuration', minDuration);
    if (maxDuration) params.set('maxDuration', maxDuration);
    if (sortField !== 'date') params.set('sortField', sortField);
    if (sortOrder !== 'desc') params.set('sortOrder', sortOrder);

    const query = params.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    
    router.replace(url, { scroll: false });
  }, [currentRepo, days, filterName, minDuration, maxDuration, sortField, sortOrder, pathname, router]);

  // Fetch data when repo or days change
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`https://api.github.com/repos/${currentRepo}/actions/runs?per_page=100`);
        if (!res.ok) throw new Error('Repository not found or API limit reached');
        const data = await res.json();
        
        const cutoffDate = subDays(new Date(), days);
        
        const processedRuns = data.workflow_runs
          .filter((r: { created_at: string | number | Date; }) => isAfter(new Date(r.created_at), cutoffDate))
          .map((r: { id: number; name: string; head_branch: string; status: string; conclusion: string; created_at: string; updated_at: string; html_url: string; }) => ({
            id: r.id,
            name: r.name,
            head_branch: r.head_branch,
            status: r.status,
            conclusion: r.conclusion,
            created_at: r.created_at,
            updated_at: r.updated_at,
            html_url: r.html_url,
            durationInSeconds: (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000
          }))
          .filter((r: Run) => r.status === 'completed');
          
        setRuns(processedRuns);
      } catch (err: unknown) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('An unknown error occurred');
        }
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [currentRepo, days]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (repoInput.trim()) setCurrentRepo(repoInput.trim());
  };

  const fetchJobsForRun = async (runId: number) => {
    if (runs.find(r => r.id === runId)?.jobs) {
      setExpandedRunId(expandedRunId === runId ? null : runId);
      return;
    }

    setRuns(prev => prev.map(r => r.id === runId ? { ...r, jobsLoading: true } : r));
    setExpandedRunId(runId);

    try {
      const res = await fetch(`https://api.github.com/repos/${currentRepo}/actions/runs/${runId}/jobs`);
      if (!res.ok) throw new Error('Failed to fetch jobs');
      const data = await res.json();
      
      const jobs = data.jobs.map((j: { id: number; name: string; status: string; conclusion: string; started_at: string; completed_at: string; html_url: string; }) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        completed_at: j.completed_at,
        html_url: j.html_url,
        durationInSeconds: j.completed_at && j.started_at 
          ? (new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000 
          : 0
      }));

      setRuns(prev => prev.map(r => r.id === runId ? { ...r, jobs, jobsLoading: false } : r));
    } catch (err) {
      console.error(err);
      setRuns(prev => prev.map(r => r.id === runId ? { ...r, jobsLoading: false } : r));
    }
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

  // Filtered and Sorted Runs
  const filteredAndSortedRuns = useMemo(() => {
    let result = [...runs];

    // Filter by name
    if (filterName) {
      const lowerQuery = filterName.toLowerCase();
      result = result.filter(r => r.name.toLowerCase().includes(lowerQuery) || r.head_branch.toLowerCase().includes(lowerQuery));
    }

    // Filter by min duration
    if (minDuration) {
      const minSeconds = parseInt(minDuration) * 60;
      if (!isNaN(minSeconds)) {
        result = result.filter(r => r.durationInSeconds >= minSeconds);
      }
    }

    // Filter by max duration
    if (maxDuration) {
      const maxSeconds = parseInt(maxDuration) * 60;
      if (!isNaN(maxSeconds)) {
        result = result.filter(r => r.durationInSeconds <= maxSeconds);
      }
    }

    // Sort
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
  }, [runs, filterName, minDuration, maxDuration, sortField, sortOrder]);

  // Stats calculation (on all runs, not just filtered)
  const totalRuns = runs.length;
  const successfulRuns = runs.filter(r => r.conclusion === 'success').length;
  const successRate = totalRuns ? Math.round((successfulRuns / totalRuns) * 100) : 0;
  const avgDuration = totalRuns ? Math.round(runs.reduce((acc, r) => acc + r.durationInSeconds, 0) / totalRuns) : 0;

  // Chart data
  const chartData = [...runs].reverse().map(r => ({
    name: format(new Date(r.created_at), 'MMM dd HH:mm'),
    duration: Math.round(r.durationInSeconds / 60), // in minutes
    success: r.conclusion === 'success' ? 1 : 0
  }));

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field || sortOrder === 'none') {
      return <ArrowUpDown className="w-3 h-3 text-neutral-300" />;
    }
    return sortOrder === 'desc' 
      ? <ArrowDown className="w-3 h-3 text-blue-500" />
      : <ArrowUp className="w-3 h-3 text-blue-500" />;
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    alert('Shareable link copied to clipboard!');
  };

  return (
    <div className="min-h-screen bg-neutral-50 p-4 md:p-8 font-sans text-neutral-900">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-xl shadow-sm border border-neutral-100">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="text-blue-500" />
              Action Insight
            </h1>
            <p className="text-neutral-500 text-sm">Monitor GitHub Actions CI/CD metrics</p>
          </div>
          
          <div className="flex w-full md:w-auto gap-2">
            <form onSubmit={handleSearch} className="flex gap-2 flex-1">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 w-4 h-4" />
                <input 
                  type="text" 
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="owner/repo"
                  className="w-full pl-9 pr-4 py-2 bg-neutral-100 rounded-lg text-sm border-transparent focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all outline-none"
                />
              </div>
              <button type="submit" className="bg-neutral-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-neutral-800 transition-colors">
                Analyze
              </button>
            </form>
            <button 
              onClick={copyShareLink}
              title="Copy link to current view"
              className="bg-neutral-100 text-neutral-600 p-2 rounded-lg hover:bg-neutral-200 transition-colors flex items-center justify-center"
            >
              <Share2 className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Controls */}
        <div className="flex gap-2">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                days === d 
                ? 'bg-blue-100 text-blue-700 border border-blue-200' 
                : 'bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-50'
              }`}
            >
              Last {d} Days
            </button>
          ))}
        </div>

        {error ? (
          <div className="bg-red-50 text-red-600 p-4 rounded-lg border border-red-100">
            {error}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-64 text-neutral-400">
            <Activity className="w-8 h-8 animate-pulse" />
          </div>
        ) : (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-full">
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500">Total Runs</p>
                  <p className="text-2xl font-bold">{totalRuns}</p>
                </div>
              </div>
              
              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4">
                <div className={`p-3 rounded-full ${successRate >= 80 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                  {successRate >= 80 ? <CheckCircle className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500">Success Rate</p>
                  <p className="text-2xl font-bold">{successRate}%</p>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4">
                <div className="p-3 bg-purple-50 text-purple-600 rounded-full">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500">Avg Duration</p>
                  <p className="text-2xl font-bold">{formatDuration(avgDuration)}</p>
                </div>
              </div>
            </div>

            {/* Charts */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100">
              <h2 className="text-lg font-bold mb-6 flex items-center gap-2">
                <CalendarIcon className="w-5 h-5 text-neutral-400" /> 
                Duration Trend (Minutes)
              </h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{fontSize: 12, fill: '#888'}} tickLine={false} axisLine={false} minTickGap={30} />
                    <YAxis tick={{fontSize: 12, fill: '#888'}} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                      cursor={{ stroke: '#f3f4f6', strokeWidth: 2 }}
                    />
                    <Line type="monotone" dataKey="duration" stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Detailed Runs with Filters */}
            <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
              <div className="p-6 border-b border-neutral-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h2 className="text-lg font-bold">Detailed Runs & Jobs</h2>
                
                <div className="flex flex-wrap gap-3 items-center text-sm">
                  <div className="flex items-center gap-2 bg-neutral-50 px-3 py-1.5 rounded-lg border border-neutral-200">
                    <Filter className="w-4 h-4 text-neutral-400" />
                    <input 
                      type="text"
                      placeholder="Filter by name..."
                      value={filterName}
                      onChange={e => setFilterName(e.target.value)}
                      className="bg-transparent border-none outline-none w-32 focus:w-40 transition-all"
                    />
                  </div>
                  
                  <div className="flex items-center gap-2 bg-neutral-50 px-3 py-1.5 rounded-lg border border-neutral-200">
                    <Clock className="w-4 h-4 text-neutral-400" />
                    <input 
                      type="number"
                      placeholder="Min (m)"
                      value={minDuration}
                      onChange={e => setMinDuration(e.target.value)}
                      className="bg-transparent border-none outline-none w-16"
                    />
                    <span className="text-neutral-300">-</span>
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
                  <thead className="bg-neutral-50 text-neutral-500 font-medium">
                    <tr>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 select-none group" onClick={() => handleSort('name')}>
                        <div className="flex items-center gap-1">
                          Workflow / Branch {getSortIcon('name')}
                        </div>
                      </th>
                      <th className="py-3 px-6">Status</th>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 select-none group" onClick={() => handleSort('duration')}>
                        <div className="flex items-center gap-1">
                          Duration {getSortIcon('duration')}
                        </div>
                      </th>
                      <th className="py-3 px-6 cursor-pointer hover:text-neutral-900 select-none group" onClick={() => handleSort('date')}>
                        <div className="flex items-center gap-1">
                          Date {getSortIcon('date')}
                        </div>
                      </th>
                      <th className="py-3 px-6 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {filteredAndSortedRuns.map(run => (
                      <React.Fragment key={run.id}>
                        <tr className="hover:bg-neutral-50/50 transition-colors">
                          <td className="py-4 px-6">
                            <div className="font-medium text-neutral-900">{run.name}</div>
                            <div className="text-neutral-500 text-xs mt-1 font-mono">{run.head_branch}</div>
                          </td>
                          <td className="py-4 px-6">
                            {run.conclusion === 'success' ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200/50">
                                <CheckCircle className="w-3.5 h-3.5" /> Success
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200/50">
                                <XCircle className="w-3.5 h-3.5" /> {run.conclusion || 'Failed'}
                              </span>
                            )}
                          </td>
                          <td className="py-4 px-6 text-neutral-600 font-mono">
                            {formatDuration(run.durationInSeconds)}
                          </td>
                          <td className="py-4 px-6 text-neutral-500">
                            {format(new Date(run.created_at), 'MMM dd, HH:mm')}
                          </td>
                          <td className="py-4 px-6 text-right">
                            <button 
                              onClick={() => fetchJobsForRun(run.id)}
                              className="inline-flex items-center gap-1 text-neutral-600 hover:text-neutral-900 px-3 py-1.5 rounded-md hover:bg-neutral-100 transition-colors"
                            >
                              {expandedRunId === run.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              Jobs
                            </button>
                            <a 
                              href={run.html_url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 ml-2 text-blue-600 hover:text-blue-700 p-1.5"
                              title="View on GitHub"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          </td>
                        </tr>
                        
                        {/* Expandable Jobs Section */}
                        {expandedRunId === run.id && (
                          <tr className="bg-neutral-50/50">
                            <td colSpan={5} className="p-0">
                              <div className="px-6 py-4 border-l-4 border-blue-500 bg-blue-50/30">
                                <h4 className="text-sm font-bold text-neutral-700 mb-3 flex items-center gap-2">
                                  Job Execution Details
                                  {run.jobsLoading && <Activity className="w-3 h-3 animate-spin text-blue-500" />}
                                </h4>
                                
                                {run.jobs && run.jobs.length > 0 ? (
                                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {run.jobs.map(job => (
                                      <div key={job.id} className="bg-white p-3 rounded-lg border border-neutral-200 shadow-sm flex flex-col gap-2">
                                        <div className="flex justify-between items-start">
                                          <span className="font-medium text-neutral-800 text-xs truncate pr-2" title={job.name}>
                                            {job.name}
                                          </span>
                                          {job.conclusion === 'success' ? (
                                            <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                                          ) : (
                                            <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                                          )}
                                        </div>
                                        <div className="flex justify-between items-center text-xs text-neutral-500">
                                          <span className="flex items-center gap-1 font-mono">
                                            <Clock className="w-3 h-3" /> {formatDuration(job.durationInSeconds)}
                                          </span>
                                          <a href={job.html_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                                            Logs
                                          </a>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : !run.jobsLoading ? (
                                  <p className="text-xs text-neutral-500">No jobs found for this run.</p>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                    {filteredAndSortedRuns.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-neutral-500">
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
    <Suspense fallback={<div className="min-h-screen bg-neutral-50 flex items-center justify-center">
      <Activity className="w-8 h-8 animate-pulse text-blue-500" />
    </div>}>
      <DashboardContent />
    </Suspense>
  );
}
