'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Search, Activity, CheckCircle, XCircle, Clock, Calendar as CalendarIcon, ExternalLink, ChevronDown, ChevronUp, Filter, ArrowUpDown, ArrowDown, ArrowUp, Share2, Info, Settings, ShieldAlert, Key, Trash2, MessageSquare, Eye, EyeOff } from 'lucide-react';
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
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [hasMoreData, setHasMoreData] = useState(false);

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  // Load token from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem('action_insight_github_token');
    if (savedToken) {
      setGithubToken(savedToken);
      setTempToken(savedToken);
    }
  }, []);

  const saveToken = () => {
    if (tempToken.trim()) {
      localStorage.setItem('action_insight_github_token', tempToken.trim());
      setGithubToken(tempToken.trim());
    } else {
      localStorage.removeItem('action_insight_github_token');
      setGithubToken('');
    }
    setShowSettings(false);
  };

  const clearToken = () => {
    localStorage.removeItem('action_insight_github_token');
    setGithubToken('');
    setTempToken('');
    setShowSettings(false);
  };

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
    let isCancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setLoadingProgress(0);
      setError('');
      setHasMoreData(false);
      
      // Start with an empty list for fresh fetch
      setRuns([]);
      
      try {
        const cutoffDate = subDays(new Date(), days);
        let allRuns: Record<string, unknown>[] = [];
        let page = 1;
        const maxPages = 5; // Fetch up to 500 runs to avoid hitting rate limits instantly
        let hitCutoff = false;

        const headers: HeadersInit = {
          'Accept': 'application/vnd.github.v3+json'
        };
        
        if (githubToken) {
          headers['Authorization'] = `Bearer ${githubToken}`;
        }

        while (page <= maxPages) {
          if (isCancelled) break;
          
          setLoadingProgress(Math.round(((page - 1) / maxPages) * 100));
          
          const res = await fetch(`https://api.github.com/repos/${currentRepo}/actions/runs?per_page=100&page=${page}`, { headers });
          
          if (!res.ok) {
            if (res.status === 403 || res.status === 401) {
              const resetHeader = res.headers.get('x-ratelimit-reset');
              const limit = res.headers.get('x-ratelimit-limit');
              const resetTime = resetHeader ? format(new Date(parseInt(resetHeader) * 1000), 'HH:mm') : '';
              const tokenMsg = githubToken 
                ? "Your provided token is either invalid or exceeded its limit." 
                : "You hit the unauthenticated GitHub API rate limit (60 requests/hr). Please add a Personal Access Token in Settings to get 5,000 requests/hr.";
              throw new Error(`API Rate Limit Exceeded or Unauthorized (Limit: ${limit || 'unknown'}). ${tokenMsg} ${resetTime ? `Resets at ${resetTime}.` : ''}`);
            }
            if (res.status === 404) {
              throw new Error(`Repository not found. Check if "${currentRepo}" exists and is public.`);
            }
            throw new Error(`GitHub API Error: ${res.statusText}`);
          }
          
          const data = await res.json();
          
          if (!data.workflow_runs || data.workflow_runs.length === 0) break;
          
          allRuns = [...allRuns, ...data.workflow_runs];
          
          // Incrementally process and show runs so user doesn't stare at a blank screen
          const currentProcessedRuns = allRuns
            .filter((r: { id: number; name: string; head_branch: string; status: string; conclusion: string; created_at: string; updated_at: string; html_url: string; }) => isAfter(new Date(r.created_at), cutoffDate))
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
            
          const uniqueRunsMap = new Map();
          currentProcessedRuns.forEach((r: Run) => uniqueRunsMap.set(r.id, r));
          
          if (!isCancelled) {
            setRuns(Array.from(uniqueRunsMap.values()));
          }
          
          // Check if the oldest run in this page is older than our cutoff date
          const oldestRunDate = new Date(data.workflow_runs[data.workflow_runs.length - 1].created_at);
          if (!isAfter(oldestRunDate, cutoffDate)) {
            hitCutoff = true;
            break;
          }
          page++;
        }
        
        // If we fetched max pages and still haven't hit the cutoff date, flag that there's more data
        if (!hitCutoff && page > maxPages && !isCancelled) {
          setHasMoreData(true);
        }
        
        if (!isCancelled) {
          setLoadingProgress(100);
        }
        
      } catch (err: unknown) {
        if (!isCancelled) {
          if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('An unknown error occurred');
          }
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
          // Only reset progress after a tiny delay so the full bar is visible briefly
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
  }, [currentRepo, days, githubToken]);

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
      const headers: HeadersInit = {
        'Accept': 'application/vnd.github.v3+json'
      };
      
      if (githubToken) {
        headers['Authorization'] = `Bearer ${githubToken}`;
      }

      const res = await fetch(`https://api.github.com/repos/${currentRepo}/actions/runs/${runId}/jobs`, { headers });
      
      if (!res.ok) throw new Error('Failed to fetch jobs (Rate limit or unauthorized)');
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
    <div className="min-h-screen bg-neutral-50 p-4 md:p-8 font-sans text-neutral-900 flex flex-col">
      {/* Top Progress Bar */}
      {loadingProgress > 0 && loadingProgress < 100 && (
        <div className="fixed top-0 left-0 w-full h-1 bg-neutral-200 z-50">
          <div 
            className="h-full bg-blue-600 transition-all duration-300 ease-out"
            style={{ width: `${loadingProgress}%` }}
          />
        </div>
      )}

      <div className="max-w-6xl mx-auto space-y-6 flex-1 w-full">
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
            <a 
              href="https://github.com/pkking/action-insight/issues/new/choose" 
              target="_blank"
              rel="noopener noreferrer"
              title="Give Feedback / Report Bug"
              className="bg-neutral-100 text-neutral-600 p-2 rounded-lg hover:bg-neutral-200 transition-colors flex items-center justify-center"
            >
              <MessageSquare className="w-5 h-5" />
            </a>
            <button 
              onClick={() => setShowSettings(true)}
              title="Settings (GitHub Token)"
              className="bg-neutral-100 text-neutral-600 p-2 rounded-lg hover:bg-neutral-200 transition-colors flex items-center justify-center relative"
            >
              <Settings className="w-5 h-5" />
              {githubToken && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-green-500 rounded-full border border-white"></span>}
            </button>
          </div>
        </header>

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl border border-neutral-100 p-6 max-w-lg w-full">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Key className="w-5 h-5 text-neutral-500" />
                  GitHub API Token
                </h2>
                <button onClick={() => setShowSettings(false)} className="text-neutral-400 hover:text-neutral-900">
                  <XCircle className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="bg-blue-50 text-blue-800 p-4 rounded-lg border border-blue-100 flex gap-3 text-sm">
                  <ShieldAlert className="w-5 h-5 shrink-0 text-blue-500 mt-0.5" />
                  <div>
                    <p className="font-semibold mb-1">100% Client-Side Security</p>
                    <p>
                      Your token is saved <strong>only in your browser&apos;s localStorage</strong>. It is never sent to any server other than directly to <code>api.github.com</code>. 
                      Providing a token boosts your API rate limit from 60 to 5,000 requests per hour.
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">
                    Fine-grained Personal Access Token
                  </label>
                  <div className="relative">
                    <input 
                      type={showToken ? "text" : "password"}
                      value={tempToken}
                      onChange={(e) => setTempToken(e.target.value)}
                      placeholder="github_pat_xxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full pl-4 pr-10 py-2 border border-neutral-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 focus:outline-none"
                    >
                      {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  
                  <div className="text-xs text-neutral-600 mt-3 space-y-2 bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                    <p className="font-semibold text-neutral-800">How to generate a token:</p>
                    <ol className="list-decimal pl-4 space-y-1.5">
                      <li>Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GitHub Settings → Fine-grained PATs</a></li>
                      <li>Click <strong>Generate new token</strong></li>
                      <li>Under <strong>Repository access</strong>, select <strong>Public Repositories (read-only)</strong></li>
                      <li>Under <strong>Permissions</strong> → <strong>Repository permissions</strong>, select <strong>Actions: Read-only</strong></li>
                      <li>Generate token and paste it above</li>
                    </ol>
                  </div>
                </div>

                <div className="flex gap-3 justify-end pt-4 border-t border-neutral-100">
                  {githubToken && (
                    <button 
                      onClick={clearToken}
                      className="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center gap-2 mr-auto"
                    >
                      <Trash2 className="w-4 h-4" /> Remove Token
                    </button>
                  )}
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={saveToken}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                  >
                    Save Token
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2 items-center flex-wrap">
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
          {hasMoreData && !loading && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg border border-amber-200 ml-auto">
              <Info className="w-4 h-4" />
              Showing latest {runs.length} runs. (GitHub API pagination limit reached for high-traffic repos)
            </div>
          )}
          {loading && runs.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-600 ml-auto">
              <Activity className="w-4 h-4 animate-spin" />
              Loading older runs...
            </div>
          )}
        </div>

        {error ? (
          <div className="bg-red-50 text-red-600 p-4 rounded-lg border border-red-100">
            {error}
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-neutral-400 flex-col gap-4">
            <Activity className="w-8 h-8 animate-pulse text-blue-500" />
            <p className="text-sm">Fetching runs (this may take a moment for larger timeframes)...</p>
          </div>
        ) : (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4 transition-all duration-300">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-full">
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500">Total Runs</p>
                  <p className="text-2xl font-bold">{totalRuns}</p>
                </div>
              </div>
              
              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4 transition-all duration-300">
                <div className={`p-3 rounded-full ${successRate >= 80 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                  {successRate >= 80 ? <CheckCircle className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-neutral-500">Success Rate</p>
                  <p className="text-2xl font-bold">{successRate}%</p>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 flex items-center gap-4 transition-all duration-300">
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
