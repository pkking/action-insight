'use client';

import { X } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { useEffect, useState } from 'react';

import { callApi } from '@/lib/api-client';

type Slice = { label: string; machineHours: number };

type CostAllocationModalProps = {
  owner: string;
  repo: string;
  startDate: string;
  endDate: string;
  workflowFile: string;
  workflowRef: string;
  onClose: () => void;
};

const PIE_COLORS = ['#3b82f6', '#14b8a6', '#f59e0b', '#a78bfa', '#ec4899', '#10b981', '#f43f5e', '#8b5cf6'];

function formatMachineHours(hours: number) {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
}

export default function CostAllocationModal({
  owner,
  repo,
  startDate,
  endDate,
  workflowFile,
  workflowRef,
  onClose,
}: CostAllocationModalProps) {
  const [mode, setMode] = useState<'resources' | 'workflows'>('resources');
  const [resourceModel, setResourceModel] = useState<string | null>(null);
  const [slices, setSlices] = useState<Slice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const request = mode === 'resources'
      ? callApi<Slice[]>('fetchCostWorkflowResources', {
          owner, repo, startDate, endDate, workflowFile, workflowRef: workflowRef || null,
        }, controller.signal)
      : callApi<Slice[]>('fetchCostResourceWorkflows', {
          owner, repo, startDate, endDate, resourceModel: resourceModel ?? '',
        }, controller.signal);
    request
      .then(setSlices)
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError('Unable to load allocation data.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [endDate, mode, owner, repo, resourceModel, startDate, workflowFile, workflowRef]);

  const total = slices.reduce((sum, slice) => sum + slice.machineHours, 0);
  const title = mode === 'resources'
    ? `${workflowFile || 'Unknown workflow'} by resource`
    : `${resourceModel} across workflows`;

  function selectResource(slice: Slice) {
    setLoading(true);
    setError(null);
    setResourceModel(slice.label);
    setMode('workflows');
  }

  function showResources() {
    setLoading(true);
    setError(null);
    setMode('resources');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="cost-allocation-title">
      <div className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-start gap-3">
          <div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{owner}/{repo} · {startDate} to {endDate}</p>
            <h2 id="cost-allocation-title" className="mt-1 text-lg font-bold">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close cost allocation" className="ml-auto rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {mode === 'workflows' && (
          <button type="button" onClick={showResources} className="mt-3 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
            ← Back to resource types
          </button>
        )}

        {loading ? (
          <div className="flex h-72 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">Loading allocation…</div>
        ) : error ? (
          <div className="flex h-72 items-center justify-center text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : slices.length === 0 ? (
          <div className="flex h-72 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">No attributable Machine-Hours in this range.</div>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={slices} dataKey="machineHours" nameKey="label" cx="50%" cy="50%" innerRadius={58} outerRadius={92} paddingAngle={2} onClick={mode === 'resources' ? (_, index) => selectResource(slices[index]) : undefined} className={mode === 'resources' ? 'cursor-pointer' : undefined}>
                    {slices.map((slice, index) => <Cell key={slice.label} fill={PIE_COLORS[index % PIE_COLORS.length]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{formatMachineHours(total)} total{mode === 'resources' ? ' · Select a resource type to see workflow share' : ''}</p>
            <ul className="mt-4 max-h-48 space-y-1 overflow-y-auto text-sm">
              {slices.map((slice, index) => (
                <li key={slice.label}>
                  <button type="button" onClick={() => mode === 'resources' && selectResource(slice)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-neutral-50 disabled:cursor-default dark:hover:bg-neutral-800" disabled={mode !== 'resources'}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                    <span className="min-w-0 flex-1 truncate">{slice.label}</span>
                    <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{formatMachineHours(slice.machineHours)} · {total > 0 ? Math.round((slice.machineHours / total) * 100) : 0}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
