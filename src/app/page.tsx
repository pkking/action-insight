'use client';

import React, { useState, useEffect } from 'react';
import { Search, Activity, CheckCircle, XCircle, Clock, Calendar as CalendarIcon, ExternalLink } from 'lucide-react';
import { 
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line
} from 'recharts';
import { format, subDays, isAfter } from 'date-fns';

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
};

export default function Dashboard() {
  const [repoInput, setRepoInput] = useState('vercel/next.js');
  const [currentRepo, setCurrentRepo] = useState('vercel/next.js');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);

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

  // Stats calculation
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
          
          <form onSubmit={handleSearch} className="flex gap-2 w-full md:w-auto">
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
                  <p className="text-2xl font-bold">{Math.round(avgDuration / 60)}m {avgDuration % 60}s</p>
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

            {/* Detailed Runs */}
            <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
              <div className="p-6 border-b border-neutral-100">
                <h2 className="text-lg font-bold">Recent CI Runs</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-neutral-50 text-neutral-500 font-medium">
                    <tr>
                      <th className="py-3 px-6">Workflow / Branch</th>
                      <th className="py-3 px-6">Status</th>
                      <th className="py-3 px-6">Duration</th>
                      <th className="py-3 px-6">Date</th>
                      <th className="py-3 px-6 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {runs.map(run => (
                      <tr key={run.id} className="hover:bg-neutral-50/50 transition-colors">
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
                          {Math.floor(run.durationInSeconds / 60)}m {run.durationInSeconds % 60}s
                        </td>
                        <td className="py-4 px-6 text-neutral-500">
                          {format(new Date(run.created_at), 'MMM dd, HH:mm')}
                        </td>
                        <td className="py-4 px-6 text-right">
                          <a 
                            href={run.html_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-xs font-medium"
                          >
                            View Logs <ExternalLink className="w-3 h-3" />
                          </a>
                        </td>
                      </tr>
                    ))}
                    {runs.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-neutral-500">
                          No runs found for the selected period.
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
