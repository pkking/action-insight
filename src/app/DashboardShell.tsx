'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  Calendar as CalendarIcon,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';

import { callApi } from '@/lib/api-client';
import {
  machineHours,
  summarizeMachineHoursByResourceModel,
} from '@/lib/dashboard-metrics';
import type {
  CostDashboardResult,
  DashboardReadResult,
  JobDashboardResult,
  PrTableRow,
  QueueDashboardResult,
  WorkflowDashboardResult,
  WorkflowTableRow,
} from '@/lib/dashboard-read-model';
import type { RepoOption } from '@/lib/server-homepage-data';
import type {
  PullRequestMetricsSummary,
  Run,
  Step,
} from '@/lib/types';

// ponytail: slice 1 ships the shared shell + PR tab; slice 2 adds the Cost
// tab (spec §5.2). Workflow / Job / Queue tabs remain stubbed. Reuses
// Recharts, the metric-tooltip pattern, date controls, repo options, and
// the existing fetchPullRequestDetail drill-down path (resource-aware).

const TABS = [
  { key: 'pr', label: 'PR' },
  { key: 'cost', label: 'Cost' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'job', label: 'Job' },
  { key: 'queue', label: 'Queue' },
] as const;

type DashboardShellProps = {
  repoOptions: RepoOption[];
  result: DashboardReadResult;
  searchParams: Record<string, string | string[] | undefined>;
};

function fmtSeconds(seconds?: number): string {
  if (seconds === undefined) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function fmtMachineHours(hours?: number): string {
  if (hours === undefined) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

function MetricTooltip({ definition }: { definition: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="group relative inline-flex">
      <span
        role="button"
        tabIndex={0}
        aria-label="Metric definition"
        onClick={() => setOpen((v) => !v)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
        }}
        className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-neutral-200 text-[10px] font-bold text-neutral-500 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300"
      >
        ?
      </span>
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 w-64 -translate-x-1/2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 shadow-md dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
        >
          {definition}
        </span>
      )}
    </span>
  );
}

function StatCard({
  label,
  definition,
  stats,
}: {
  label: string;
  definition: string;
  stats: { avg: number; p50: number; p90: number; sampleCount: number };
}) {
  // ponytail: durations rendered in seconds-via-fmtSeconds; no separate suffix knob needed yet.
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
        <MetricTooltip definition={definition} />
      </div>
      {stats.sampleCount === 0 ? (
        <div className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">No valid samples</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">
          <span>avg {fmtSeconds(stats.avg)}</span>
          <span>p50 {fmtSeconds(stats.p50)}</span>
          <span>p90 {fmtSeconds(stats.p90)}</span>
        </div>
      )}
      <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
        n={stats.sampleCount}
      </div>
    </div>
  );
}

type PrDetail = PullRequestMetricsSummary & { workflows: Run[] };

function PrDrillDown({
  detail,
  loading,
}: {
  detail: PrDetail | undefined;
  loading: boolean;
}) {
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());

  const allJobs = useMemo(() => {
    if (!detail) return [];
    return detail.workflows.flatMap((wf) =>
      (wf.jobs ?? []).map((job) => ({
        job,
        workflow: wf,
        identity: `${wf.id}:${wf.runAttempt ?? 1}:${job.id}`,
      })),
    );
  }, [detail]);

  const resourceSummary = useMemo(
    () =>
      summarizeMachineHoursByResourceModel(
        allJobs.map(({ job }) => ({
          resourceModel: job.resource_model,
          resourceCount: job.resource_count,
          runtimeSeconds: job.runtimeInSeconds,
        })),
      ),
    [allJobs],
  );

  if (loading) {
    return (
      <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">
        Loading CI breakdown…
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">
        No detail available.
      </div>
    );
  }

  const toggleJob = (identity: string) =>
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });

  return (
    <div className="space-y-3 px-6 py-4">
      {/* Machine-Hours by Resource Model */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">
          Machine-Hours by Resource Model
        </div>
        {resourceSummary.length === 0 ? (
          <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            No tracked jobs with resource attribution.
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {resourceSummary.map((entry) => (
              <span
                key={entry.resourceModel}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-900"
              >
                <span className="font-medium text-neutral-700 dark:text-neutral-200">
                  {entry.resourceModel}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {fmtMachineHours(entry.machineHours)}
                </span>
                {entry.unknownCostCount > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    ({entry.unknownCostCount} unknown)
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Job list */}
      {allJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
          No tracked workflow jobs for this PR.
        </div>
      ) : (
        <div className="space-y-1.5">
          {allJobs.map(({ job, workflow, identity }) => {
            const expanded = expandedJobs.has(identity);
            const steps = job.steps ?? [];
            const mh = machineHours(job.runtimeInSeconds, job.resource_count);
            return (
              <div key={identity} className="rounded-lg border border-neutral-200 dark:border-neutral-700">
                <button
                  type="button"
                  onClick={() => steps.length > 0 && toggleJob(identity)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  {steps.length > 0 ? (
                    expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <span className="h-1 w-1 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                  )}
                  <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">
                    {job.name}
                  </span>
                  {job.resource_model && (
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {job.resource_model}
                      {job.resource_count ? ` ×${job.resource_count}` : ''}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                    {fmtSeconds(job.runtimeInSeconds)}
                  </span>
                  <span className="font-mono text-[11px] text-blue-600 dark:text-blue-400">
                    {fmtMachineHours(mh)}
                  </span>
                  <StatusDot conclusion={job.conclusion} />
                </button>
                {expanded && steps.length > 0 && (
                  <div className="border-t border-neutral-100 px-6 py-1.5 dark:border-neutral-800">
                    {steps.map((step) => (
                      <StepRow key={step.number} step={step} />
                    ))}
                  </div>
                )}
                {expanded && steps.length === 0 && (
                  <div className="border-t border-neutral-100 px-6 py-2 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
                    Step data not eligible/collected for this job.
                  </div>
                )}
                <div className="px-3 pb-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                  {workflow.name}
                  {workflow.runAttempt && workflow.runAttempt > 1 ? ` · attempt ${workflow.runAttempt}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const seconds =
    step.duration_seconds ??
    (step.started_at && step.completed_at
      ? Math.max(0, Math.round((Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000))
      : 0);
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
      <span className="text-amber-500">▸</span>
      <span className="truncate">{step.name}</span>
      <span className="flex-1" />
      <span className="font-mono text-neutral-400 dark:text-neutral-500">{fmtSeconds(seconds)}</span>
      <StatusDot conclusion={step.conclusion} />
    </div>
  );
}

function StatusDot({ conclusion }: { conclusion: string }) {
  if (conclusion === 'success')
    return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
  if (conclusion === 'skipped')
    return <Info className="h-3.5 w-3.5 text-neutral-400" />;
  return <XCircle className="h-3.5 w-3.5 text-red-500" />;
}

const COST_REPO_COLORS = ['#3b82f6', '#14b8a6', '#f59e0b', '#a78bfa', '#ec4899', '#10b981', '#f43f5e', '#8b5cf6'];

/** Cost tab body: Machine-Hour cards, daily per-repo trend, grouped table (spec §5.2). */
function CostBody({
  result,
}: {
  result: CostDashboardResult;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const cards = result.cards;

  // Map of repoKey → color for the multi-line chart.
  const repoColors = useMemo(() => {
    const keys = [...new Set(result.series.map((p) => p.repoKey))];
    return new Map(keys.map((key, i) => [key, COST_REPO_COLORS[i % COST_REPO_COLORS.length]]));
  }, [result.series]);

  // Pivot the daily series into one row per date with a column per repo.
  const dailyData = useMemo(() => {
    const byDate = new Map<string, Record<string, number>>();
    for (const p of result.series) {
      const row = byDate.get(p.date) ?? {};
      row[p.repoKey] = (row[p.repoKey] ?? 0) + p.machineHours;
      byDate.set(p.date, row);
    }
    return [...byDate.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [result.series]);

  const reposInSeries = useMemo(
    () => [...repoColors.keys()],
    [repoColors],
  );

  const totalPages = Math.max(1, Math.ceil(result.totalRows / result.pageSize));
  const currentPage = Math.min(result.page, totalPages);

  function pushPage(page: number) {
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set('page', String(page));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <>
      {/* Cost metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <CostCard label="Total Machine-Hours" definition="Job Runtime × Resource Count ÷ 3600, excluding queue (spec §4)." value={fmtMachineHours(cards.totalMachineHours)} />
        <CostCard
          label="Per Merged PR"
          definition="Total Machine-Hours ÷ merged PRs with at least one attributable job in the window."
          value={cards.machineHoursPerMergedPr !== undefined ? fmtMachineHours(cards.machineHoursPerMergedPr) : '—'}
        />
        <CostCard
          label={cards.topWorkflow ? 'Top Workflow' : 'Top Repository'}
          definition={cards.topWorkflow ? 'Highest-Machine-Hour workflow in the selected repository.' : 'Highest-Machine-Hour repository.'}
          value={(cards.topWorkflow?.workflowFile ?? cards.topRepo?.repoKey ?? '—')}
          sub={fmtMachineHours(cards.topWorkflow?.machineHours ?? cards.topRepo?.machineHours)}
        />
        <CostCard label="Daily Average" definition="Total Machine-Hours ÷ days in the selected range." value={fmtMachineHours(cards.dailyAverageMachineHours)} />
        <CostCard
          label={cards.topWorkflow ? 'PR Count' : 'Repos'}
          definition={cards.topWorkflow ? 'Merged PRs with attributable jobs in the window.' : 'Repositories contributing Machine-Hours.'}
          value={String(cards.contributingCount)}
        />
      </div>

      {/* Data-quality / truncation notices */}
      {result.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Showing latest {result.displayedObservationCount} of {result.totalRows} workflow/resource groups — narrow the date range to see all.
        </div>
      )}
      {result.quality.unknownResourceSamples > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
          {result.quality.unknownResourceSamples} job(s) without a positive Resource Count / valid runtime are excluded from Machine-Hours (Unknown-Cost).
        </div>
      )}

      {/* Chart: daily Machine-Hours per repository */}
      <div className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 text-lg font-bold">Daily Machine-Hours by Repository</h2>
        {dailyData.length === 0 ? (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No attributable jobs in the selected range.
          </div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => fmtMachineHours(Number(value))} />
                <Legend />
                {reposInSeries.map((repoKey) => (
                  <Line
                    key={repoKey}
                    type="monotone"
                    dataKey={repoKey}
                    stroke={repoColors.get(repoKey)}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Paged detail table: one row per (workflow, resource model) */}
      <div className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-bold">Cost by Workflow &amp; Resource</h2>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {result.displayedObservationCount} group(s){result.truncated ? ' (truncated)' : ''}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3">Repo</th>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Resource Model</th>
                <th className="px-4 py-3">Avg Total</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Success</th>
                <th className="px-4 py-3">Fail Rate</th>
                <th className="px-4 py-3">Machine-Hours</th>
                <th className="px-4 py-3">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    No tracked workflow jobs in range. Try “All repositories” or a wider range.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/60">
                    <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">{row.repoKey}</td>
                    <td className="px-4 py-3 font-medium" title={row.workflowRef || undefined}>{row.workflowFile || '—'}</td>
                    <td className="px-4 py-3 text-xs">{row.resourceModel || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.avgWorkflowTotalDuration)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{row.attemptCount}</td>
                    <td className="px-4 py-3 font-mono text-xs text-emerald-600 dark:text-emerald-400">{row.successCount}</td>
                    <td className="px-4 py-3 font-mono text-xs">{Math.round(row.failureRate)}%</td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">{fmtMachineHours(row.machineHours)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">{Math.round(row.shareOfTotal)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {result.totalRows > result.pageSize && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Page {currentPage} of {totalPages} · {result.totalRows} groups
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => pushPage(currentPage - 1)}
                className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => pushPage(currentPage + 1)}
                className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function CostCard({
  label,
  definition,
  value,
  sub,
}: {
  label: string;
  definition: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
        <MetricTooltip definition={definition} />
      </div>
      <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">{sub}</div>}
    </div>
  );
}

type WorkflowDrilldownAttempt = {
  runId: number;
  runAttempt: number;
  repoKey: string;
  queueDurationSeconds: number | null;
  runtimeSeconds: number | null;
  totalDurationSeconds: number | null;
  conclusion: string | null;
  status: string;
  runDate: string;
};

/** Workflow tab body: attempt cards, daily attempt-count chart, grouped table (spec §5.3). */
function WorkflowBody({
  result,
  repoOptions,
}: {
  result: WorkflowDashboardResult;
  repoOptions: RepoOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const cards = result.cards;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<Record<string, WorkflowDrilldownAttempt[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const keysInSeries = useMemo(
    () => [...new Set(result.series.map((p) => p.key))],
    [result.series],
  );
  const keyColors = useMemo(() => {
    return new Map(
      keysInSeries.map((key, i) => [key, COST_REPO_COLORS[i % COST_REPO_COLORS.length]]),
    );
  }, [keysInSeries]);

  // Pivot the daily series into one row per date with a column per key.
  const dailyData = useMemo(() => {
    const byDate = new Map<string, Record<string, number>>();
    for (const p of result.series) {
      const row = byDate.get(p.date) ?? {};
      row[p.key] = (row[p.key] ?? 0) + p.attempts;
      byDate.set(p.date, row);
    }
    return [...byDate.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [result.series]);

  const totalPages = Math.max(1, Math.ceil(result.totalRows / result.pageSize));
  const currentPage = Math.min(result.page, totalPages);

  function pushPage(page: number) {
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set('page', String(page));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  async function loadDrilldown(row: WorkflowTableRow) {
    const key = [row.repoKey, row.workflowFile, row.workflowRef, row.resourceModel].join('\u0001');
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    if (drilldown[key]) {
      setExpanded(key);
      return;
    }
    const repo = repoOptions.find((r) => r.key === row.repoKey);
    if (!repo) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoadingKey(key);
    setExpanded(key);
    try {
      const attempts = await callApi<WorkflowDrilldownAttempt[]>(
        'fetchWorkflowAttempts',
        {
          owner: repo.owner,
          repo: repo.repo,
          workflowFile: row.workflowFile,
          workflowRef: row.workflowRef || null,
          resourceModel: row.resourceModel === 'unknown' ? null : row.resourceModel,
        },
        abortRef.current.signal,
      );
      setDrilldown((cur) => ({ ...cur, [key]: attempts }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Failed to load workflow attempts', err);
    } finally {
      setLoadingKey((cur) => (cur === key ? null : cur));
    }
  }

  const isOneRepo = Boolean(cards.topWorkflow);

  return (
    <>
      {/* Workflow metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <CostCard label="Total Attempts" definition="Tracked workflow attempts in the window (spec §5.3)." value={String(cards.totalAttempts)} />
        <CostCard
          label="P50 Total"
          definition="Median Workflow Total Duration over successful attempts (spec §4)."
          value={cards.p50TotalDuration !== undefined ? fmtSeconds(cards.p50TotalDuration) : '—'}
        />
        <CostCard
          label="P90 Total"
          definition="90th-percentile Workflow Total Duration over successful attempts (spec §4)."
          value={cards.p90TotalDuration !== undefined ? fmtSeconds(cards.p90TotalDuration) : '—'}
        />
        <CostCard
          label="Success Rate"
          definition="Successful terminal attempts ÷ all terminal attempts (spec §4)."
          value={cards.totalAttempts > 0 ? `${Math.round(cards.successRate)}%` : '—'}
        />
        {isOneRepo ? (
          <CostCard
            label="Top Workflow"
            definition="Highest-Machine-Hour workflow in the selected repository."
            value={cards.topWorkflow?.workflowFile ?? '—'}
            sub={fmtMachineHours(cards.topWorkflow?.machineHours)}
          />
        ) : (
          <CostCard label="Repos" definition="Repositories contributing tracked attempts." value={String(cards.contributingRepoCount)} />
        )}
      </div>

      {result.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Showing latest {result.displayedObservationCount} of {result.totalRows} workflow/resource groups — narrow the date range to see all.
        </div>
      )}
      {result.quality.unknownResourceSamples > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
          {result.quality.unknownResourceSamples} job(s) without a positive Resource Count / valid runtime are excluded from Machine-Hours (Unknown-Cost).
        </div>
      )}

      {/* Chart: daily attempt count per repo / per workflow */}
      <div className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 text-lg font-bold">
          Daily Attempts {isOneRepo ? 'by Workflow' : 'by Repository'}
        </h2>
        {dailyData.length === 0 ? (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No tracked attempts in the selected range.
          </div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Legend />
                {keysInSeries.map((key) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={keyColors.get(key)}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Paged grouped table with lazy drill-down */}
      <div className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-bold">Workflow &amp; Resource Breakdown</h2>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {result.displayedObservationCount} group(s){result.truncated ? ' (truncated)' : ''}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3">Repo</th>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Resource Model</th>
                <th className="px-4 py-3">Avg Total</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Success</th>
                <th className="px-4 py-3">Fail Rate</th>
                <th className="px-4 py-3">Machine-Hours</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    No tracked workflow attempts in range. Try “All repositories” or a wider range.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, i) => {
                  const key = [row.repoKey, row.workflowFile, row.workflowRef, row.resourceModel].join('\u0001');
                  const isOpen = expanded === key;
                  const attempts = drilldown[key];
                  return (
                    <React.Fragment key={i}>
                      <tr
                        className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-950/60"
                        onClick={() => loadDrilldown(row)}
                      >
                        <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">{row.repoKey}</td>
                        <td className="px-4 py-3 font-medium" title={row.workflowRef || undefined}>
                          {isOpen ? <ChevronDown className="mr-1 inline h-3.5 w-3.5" /> : <ChevronRight className="mr-1 inline h-3.5 w-3.5" />}
                          {row.workflowFile || '—'}
                        </td>
                        <td className="px-4 py-3 text-xs">{row.resourceModel || '—'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.avgWorkflowTotalDuration)}</td>
                        <td className="px-4 py-3 font-mono text-xs">{row.attemptCount}</td>
                        <td className="px-4 py-3 font-mono text-xs text-emerald-600 dark:text-emerald-400">{row.successCount}</td>
                        <td className="px-4 py-3 font-mono text-xs">{Math.round(row.failureRate)}%</td>
                        <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">{fmtMachineHours(row.machineHours)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={8} className="bg-neutral-50/50 dark:bg-neutral-950/40">
                            <WorkflowDrillDown attempts={attempts} loading={loadingKey === key} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {result.totalRows > result.pageSize && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Page {currentPage} of {totalPages} · {result.totalRows} groups
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => pushPage(currentPage - 1)}
                className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => pushPage(currentPage + 1)}
                className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Stacked queue/runtime chart + attempt list for an expanded workflow row (spec §5.3). */
function WorkflowDrillDown({
  attempts,
  loading,
}: {
  attempts?: WorkflowDrilldownAttempt[];
  loading: boolean;
}) {
  const chartData = useMemo(
    () =>
      (attempts ?? []).map((a) => ({
        label: `#${a.runId}/${a.runAttempt}`,
        queue: a.queueDurationSeconds ?? 0,
        runtime: a.runtimeSeconds ?? 0,
        conclusion: a.conclusion,
        runDate: a.runDate,
      })),
    [attempts],
  );

  if (loading) {
    return (
      <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">
        Loading workflow attempts…
      </div>
    );
  }

  if (!attempts || attempts.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">
        No tracked attempts for this workflow/resource group.
      </div>
    );
  }

  return (
    <div className="space-y-3 px-6 py-4">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" angle={-30} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
            <Tooltip formatter={(value) => fmtSeconds(Number(value))} />
            <Legend />
            <Bar dataKey="queue" name="Queue" stackId="a" fill="#60a5fa" />
            <Bar dataKey="runtime" name="Runtime" stackId="a" fill="#34d399" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-400 dark:text-neutral-500">
            <tr>
              <th className="px-2 py-1">Run / Attempt</th>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Queue</th>
              <th className="px-2 py-1">Runtime</th>
              <th className="px-2 py-1">Conclusion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {attempts.map((a) => (
              <tr key={`${a.runId}:${a.runAttempt}`}>
                <td className="px-2 py-1 font-mono">{a.runId}/{a.runAttempt}</td>
                <td className="px-2 py-1 text-neutral-500 dark:text-neutral-400">{a.runDate}</td>
                <td className="px-2 py-1 font-mono">{fmtSeconds(a.queueDurationSeconds ?? undefined)}</td>
                <td className="px-2 py-1 font-mono">{fmtSeconds(a.runtimeSeconds ?? undefined)}</td>
                <td className="px-2 py-1"><StatusDot conclusion={a.conclusion ?? ''} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type JobDrilldownAttempt = {
  runId: number;
  runAttempt: number;
  jobId: number;
  repoKey: string;
  queueDurationSeconds: number | null;
  runtimeSeconds: number | null;
  totalDurationSeconds: number | null;
  resourceModel: string | null;
  conclusion: string | null;
  runDate: string;
};

/** Job tab body: job cards, daily job-count chart, grouped table (spec §5.4). */
function JobBody({
  result,
  repoOptions,
}: {
  result: JobDashboardResult;
  repoOptions: RepoOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const cards = result.cards;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<Record<string, JobDrilldownAttempt[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const keysInSeries = useMemo(
    () => [...new Set(result.series.map((p) => p.key))],
    [result.series],
  );
  const keyColors = useMemo(
    () =>
      new Map(
        keysInSeries.map((key, i) => [key, COST_REPO_COLORS[i % COST_REPO_COLORS.length]]),
      ),
    [keysInSeries],
  );
  const dailyData = useMemo(() => {
    const byDate = new Map<string, Record<string, number>>();
    for (const p of result.series) {
      const row = byDate.get(p.date) ?? {};
      row[p.key] = (row[p.key] ?? 0) + p.jobs;
      byDate.set(p.date, row);
    }
    return [...byDate.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [result.series]);

  const totalPages = Math.max(1, Math.ceil(result.totalRows / result.pageSize));
  const currentPage = Math.min(result.page, totalPages);
  const isOneRepo = Boolean(cards.topJob);

  function pushPage(page: number) {
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set('page', String(page));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  async function loadDrilldown(row: JobTableRowLike) {
    const key = [row.repoKey, row.workflowFile, row.workflowRef, row.jobName, row.resourceModel].join('\u0001');
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    if (drilldown[key]) {
      setExpanded(key);
      return;
    }
    const repo = repoOptions.find((r) => r.key === row.repoKey);
    if (!repo) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoadingKey(key);
    setExpanded(key);
    try {
      const attempts = await callApi<JobDrilldownAttempt[]>('fetchJobAttempts', {
        owner: repo.owner,
        repo: repo.repo,
        workflowFile: row.workflowFile,
        workflowRef: row.workflowRef || null,
        jobName: row.jobName,
        resourceModel: row.resourceModel === 'unknown' ? null : row.resourceModel,
      }, abortRef.current.signal);
      setDrilldown((cur) => ({ ...cur, [key]: attempts }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Failed to load job attempts', err);
    } finally {
      setLoadingKey((cur) => (cur === key ? null : cur));
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <CostCard label="Total Jobs" definition="Tracked workflow_jobs in the window (spec §5.4)." value={String(cards.totalJobs)} />
        <CostCard label="P50 Total" definition="Median Job Total Duration over successful jobs (spec §4)." value={cards.p50TotalDuration !== undefined ? fmtSeconds(cards.p50TotalDuration) : '—'} />
        <CostCard label="P90 Total" definition="90th-percentile Job Total Duration over successful jobs (spec §4)." value={cards.p90TotalDuration !== undefined ? fmtSeconds(cards.p90TotalDuration) : '—'} />
        <CostCard label="Success Rate" definition="Successful terminal jobs ÷ all terminal jobs (spec §4)." value={cards.totalJobs > 0 ? `${Math.round(cards.successRate)}%` : '—'} />
        {isOneRepo ? (
          <CostCard label="Top Job" definition="Highest-Machine-Hour job in the selected repository." value={cards.topJob?.jobName || '—'} sub={fmtMachineHours(cards.topJob?.machineHours)} />
        ) : (
          <CostCard label="Repos" definition="Repositories contributing tracked jobs." value={String(cards.contributingRepoCount)} />
        )}
      </div>

      {result.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Showing latest {result.displayedObservationCount} of {result.totalRows} job/resource groups — narrow the date range to see all.
        </div>
      )}
      {result.quality.unknownResourceSamples > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
          {result.quality.unknownResourceSamples} job(s) without a positive Resource Count / valid runtime are excluded from Machine-Hours (Unknown-Cost).
        </div>
      )}

      <div className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 text-lg font-bold">Daily Jobs {isOneRepo ? 'by Job' : 'by Repository'}</h2>
        {dailyData.length === 0 ? (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No tracked jobs in the selected range.
          </div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Legend />
                {keysInSeries.map((key) => (
                  <Line key={key} type="monotone" dataKey={key} stroke={keyColors.get(key)} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-bold">Job &amp; Resource Breakdown</h2>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {result.displayedObservationCount} group(s){result.truncated ? ' (truncated)' : ''}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3">Repo</th>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Resource Model</th>
                <th className="px-4 py-3">Avg Total</th>
                <th className="px-4 py-3">Execs</th>
                <th className="px-4 py-3">Success</th>
                <th className="px-4 py-3">Fail Rate</th>
                <th className="px-4 py-3">Machine-Hours</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    No tracked jobs in range. Try “All repositories” or a wider range.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, i) => {
                  const key = [row.repoKey, row.workflowFile, row.workflowRef, row.jobName, row.resourceModel].join('\u0001');
                  const isOpen = expanded === key;
                  const attempts = drilldown[key];
                  return (
                    <React.Fragment key={i}>
                      <tr className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-950/60" onClick={() => loadDrilldown(row)}>
                        <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">{row.repoKey}</td>
                        <td className="px-4 py-3 font-medium" title={row.workflowRef || undefined}>{row.workflowFile || '—'}</td>
                        <td className="px-4 py-3 font-medium">{isOpen ? <ChevronDown className="mr-1 inline h-3.5 w-3.5" /> : <ChevronRight className="mr-1 inline h-3.5 w-3.5" />}{row.jobName || '—'}</td>
                        <td className="px-4 py-3 text-xs">{row.resourceModel || '—'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.avgJobTotalDuration)}</td>
                        <td className="px-4 py-3 font-mono text-xs">{row.executionCount}</td>
                        <td className="px-4 py-3 font-mono text-xs text-emerald-600 dark:text-emerald-400">{row.successCount}</td>
                        <td className="px-4 py-3 font-mono text-xs">{Math.round(row.failureRate)}%</td>
                        <td className="px-4 py-3 font-mono text-xs text-blue-600 dark:text-blue-400">{fmtMachineHours(row.machineHours)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={9} className="bg-neutral-50/50 dark:bg-neutral-950/40">
                            <JobDrillDown attempts={attempts} loading={loadingKey === key} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {result.totalRows > result.pageSize && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Page {currentPage} of {totalPages} · {result.totalRows} groups</span>
            <div className="flex gap-2">
              <button type="button" disabled={currentPage <= 1} onClick={() => pushPage(currentPage - 1)} className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"><ChevronLeft className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={currentPage >= totalPages} onClick={() => pushPage(currentPage + 1)} className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"><ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

type JobTableRowLike = {
  repoKey: string;
  workflowFile: string;
  workflowRef: string;
  jobName: string;
  resourceModel: string;
};

/** Stacked queue/runtime chart + job attempt list for an expanded job row (spec §5.4). */
function JobDrillDown({
  attempts,
  loading,
}: {
  attempts?: JobDrilldownAttempt[];
  loading: boolean;
}) {
  const chartData = useMemo(
    () =>
      (attempts ?? []).map((a) => ({
        label: `#${a.runId}/${a.runAttempt}/${a.jobId}`,
        queue: a.queueDurationSeconds ?? 0,
        runtime: a.runtimeSeconds ?? 0,
        conclusion: a.conclusion,
        runDate: a.runDate,
      })),
    [attempts],
  );

  if (loading) {
    return <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">Loading job attempts…</div>;
  }
  if (!attempts || attempts.length === 0) {
    return <div className="px-6 py-4 text-sm text-neutral-500 dark:text-neutral-400">No tracked attempts for this job/resource group.</div>;
  }

  return (
    <div className="space-y-3 px-6 py-4">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" angle={-30} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
            <Tooltip formatter={(value) => fmtSeconds(Number(value))} />
            <Legend />
            <Bar dataKey="queue" name="Queue" stackId="a" fill="#60a5fa" />
            <Bar dataKey="runtime" name="Runtime" stackId="a" fill="#34d399" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-400 dark:text-neutral-500">
            <tr>
              <th className="px-2 py-1">Run/Attempt/Job</th>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Queue</th>
              <th className="px-2 py-1">Runtime</th>
              <th className="px-2 py-1">Model</th>
              <th className="px-2 py-1">Conclusion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {attempts.map((a) => (
              <tr key={`${a.runId}:${a.runAttempt}:${a.jobId}`}>
                <td className="px-2 py-1 font-mono">{a.runId}/{a.runAttempt}/{a.jobId}</td>
                <td className="px-2 py-1 text-neutral-500 dark:text-neutral-400">{a.runDate}</td>
                <td className="px-2 py-1 font-mono">{fmtSeconds(a.queueDurationSeconds ?? undefined)}</td>
                <td className="px-2 py-1 font-mono">{fmtSeconds(a.runtimeSeconds ?? undefined)}</td>
                <td className="px-2 py-1">{a.resourceModel || '—'}</td>
                <td className="px-2 py-1"><StatusDot conclusion={a.conclusion ?? ''} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Queue tab body: queue cards, daily P90-per-model chart, grouped table (spec §5.5). */
function QueueBody({
  result,
  repoOptions,
}: {
  result: QueueDashboardResult;
  repoOptions: RepoOption[];
}) {
  void repoOptions;
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const cards = result.cards;

  const modelsInSeries = useMemo(
    () => [...new Set(result.series.map((p) => p.resourceModel))],
    [result.series],
  );
  const modelColors = useMemo(
    () => new Map(modelsInSeries.map((m, i) => [m, COST_REPO_COLORS[i % COST_REPO_COLORS.length]])),
    [modelsInSeries],
  );
  const dailyData = useMemo(() => {
    const byDate = new Map<string, Record<string, number>>();
    for (const p of result.series) {
      const row = byDate.get(p.date) ?? {};
      row[p.resourceModel] = p.p90;
      byDate.set(p.date, row);
    }
    return [...byDate.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [result.series]);

  const totalPages = Math.max(1, Math.ceil(result.totalRows / result.pageSize));
  const currentPage = Math.min(result.page, totalPages);

  function pushPage(page: number) {
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set('page', String(page));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function setResourceModel(model: string) {
    const params = new URLSearchParams(urlSearchParams.toString());
    if (model) params.set('resourceModel', model);
    else params.delete('resourceModel');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const selectedModel = urlSearchParams.get('resourceModel') || '';

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <CostCard label="P50 Queue" definition="Median Job Queue Duration over valid queue samples (spec §5.5)." value={cards.p50QueueDuration !== undefined ? fmtSeconds(cards.p50QueueDuration) : '—'} />
        <CostCard label="P90 Queue" definition="90th-percentile Job Queue Duration over valid samples (spec §5.5)." value={cards.p90QueueDuration !== undefined ? fmtSeconds(cards.p90QueueDuration) : '—'} />
        <CostCard label="Max Queue" definition="Longest valid Job Queue Duration in the window." value={cards.maxQueueDuration !== undefined ? fmtSeconds(cards.maxQueueDuration) : '—'} />
        <CostCard label="Share > 1h" definition="Valid queue samples exceeding one hour ÷ all valid samples (spec §5.5)." value={cards.p90QueueDuration !== undefined ? `${Math.round(cards.shareOverOneHour)}%` : '—'} />
        <CostCard label="Resource Models" definition="Distinct Resource Models contributing queue samples." value={String(cards.distinctResourceModelCount)} />
      </div>

      {result.truncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Showing latest {result.displayedObservationCount} of {result.totalRows} job groups — narrow the date range to see all.
        </div>
      )}
      {result.quality.invalidTimingSamples > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
          {result.quality.invalidTimingSamples} job(s) with invalid/missing queue duration excluded from queue percentiles.
        </div>
      )}

      {/* Resource Model filter (Queue secondary filter, spec §3) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">Resource Model:</span>
        <button type="button" onClick={() => setResourceModel('')} className={`rounded-md border px-2 py-1 text-xs ${!selectedModel ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400' : 'border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'}`}>All</button>
        {modelsInSeries.map((m) => (
          <button key={m} type="button" onClick={() => setResourceModel(m)} className={`rounded-md border px-2 py-1 text-xs ${selectedModel === m ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400' : 'border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'}`}>{m}</button>
        ))}
      </div>

      <div className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 text-lg font-bold">Daily Queue P90 by Resource Model</h2>
        {dailyData.length === 0 ? (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No valid queue samples in the selected range.
          </div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value) => fmtSeconds(Number(value))} />
                <Legend />
                {modelsInSeries.map((m) => (
                  <Line key={m} type="monotone" dataKey={m} stroke={modelColors.get(m)} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-bold">Queue by Job &amp; Resource Model</h2>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            {result.displayedObservationCount} group(s){result.truncated ? ' (truncated)' : ''}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3">Repo</th>
                <th className="px-4 py-3">Workflow</th>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Resource Model</th>
                <th className="px-4 py-3">Queue P90</th>
                <th className="px-4 py-3">Execs</th>
                <th className="px-4 py-3">Success Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    No valid queue samples in range. Try “All repositories” or a wider range.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/60">
                    <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">{row.repoKey}</td>
                    <td className="px-4 py-3 font-medium" title={row.workflowRef || undefined}>{row.workflowFile || '—'}</td>
                    <td className="px-4 py-3 font-medium">{row.jobName || '—'}</td>
                    <td className="px-4 py-3 text-xs">{row.resourceModel || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.queueP90)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{row.executionCount}</td>
                    <td className="px-4 py-3 font-mono text-xs">{Math.round(row.successRate)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {result.totalRows > result.pageSize && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Page {currentPage} of {totalPages} · {result.totalRows} groups</span>
            <div className="flex gap-2">
              <button type="button" disabled={currentPage <= 1} onClick={() => pushPage(currentPage - 1)} className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"><ChevronLeft className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={currentPage >= totalPages} onClick={() => pushPage(currentPage + 1)} className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"><ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default function DashboardShell({
  repoOptions,
  result,
  searchParams,
}: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();

  const [selectedRepoKey, setSelectedRepoKey] = useState<string>(
    (typeof searchParams.repo === 'string' && searchParams.repo) || '',
  );
  const [useCustomRange, setUseCustomRange] = useState<boolean>(
    searchParams.useCustomRange === 'true',
  );
  const [startDate, setStartDate] = useState<string>(
    (typeof searchParams.startDate === 'string' && searchParams.startDate) || '',
  );
  const [endDate, setEndDate] = useState<string>(
    (typeof searchParams.endDate === 'string' && searchParams.endDate) || '',
  );
  const [days, setDays] = useState<number>(() => {
    const raw = searchParams.days;
    const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
  const [expandedPr, setExpandedPr] = useState<string | null>(null);
  const [detailsByPr, setDetailsByPr] = useState<Record<string, PrDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const lastUrlRef = useRef<string>('');

  const activeTab = result.tab;
  const tabDefaultDays = activeTab === 'pr' ? 1 : 14;

  // Sync state → URL. `tab` is read back from the current URL so a tab switch
  // (written directly by switchTab) survives subsequent filter edits.
  useEffect(() => {
    const params = new URLSearchParams();
    const urlTab = urlSearchParams.get('tab');
    if (urlTab && urlTab !== 'pr') params.set('tab', urlTab);
    if (selectedRepoKey) params.set('repo', selectedRepoKey);
    if (useCustomRange) {
      params.set('useCustomRange', 'true');
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
    } else if (days !== tabDefaultDays) {
      params.set('days', String(days));
    }
    const query = params.toString();
    const nextUrl = query ? `${pathname}?${query}` : pathname;
    if (lastUrlRef.current === nextUrl) return;
    lastUrlRef.current = nextUrl;
    router.replace(nextUrl, { scroll: false });
  }, [days, endDate, pathname, router, selectedRepoKey, startDate, tabDefaultDays, urlSearchParams, useCustomRange]);

  /** Switch the active tab, resetting the date filter to that tab's default. */
  const switchTab = useCallback(
    (tab: 'pr' | 'cost' | 'workflow' | 'job' | 'queue') => {
      if (tab === activeTab) return;
      const defaultDays = tab === 'pr' ? 1 : 14;
      setUseCustomRange(false);
      setDays(defaultDays);
      const params = new URLSearchParams();
      params.set('tab', tab);
      if (selectedRepoKey) params.set('repo', selectedRepoKey);
      // days omitted → server applies the tab default (matches local defaultDays)
      lastUrlRef.current = `${pathname}?${params.toString()}`;
      router.replace(lastUrlRef.current, { scroll: false });
    },
    [activeTab, pathname, router, selectedRepoKey],
  );

  const selectedRepo = useMemo(
    () =>
      repoOptions.find((r) => r.key === selectedRepoKey) ??
      (repoOptions.length > 0 ? repoOptions[0] : null),
    [repoOptions, selectedRepoKey],
  );

  const loadDetail = useCallback(
    async (repoKey: string, prNumber: number) => {
      const key = `${repoKey}:${prNumber}`;
      if (detailsByPr[key]) {
        setExpandedPr(expandedPr === key ? null : key);
        return;
      }
      const repo = repoOptions.find((r) => r.key === repoKey);
      if (!repo) return;
      detailAbortRef.current?.abort();
      detailAbortRef.current = new AbortController();
      setLoadingDetail(key);
      setExpandedPr(key);
      try {
        const detail = await callApi<{ pr: PrDetail }>(
          'fetchPullRequestDetail',
          { owner: repo.owner, repo: repo.repo, number: prNumber },
          detailAbortRef.current.signal,
        );
        setDetailsByPr((cur) => ({ ...cur, [key]: detail.pr }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Failed to load PR detail', err);
      } finally {
        setLoadingDetail((cur) => (cur === key ? null : cur));
      }
    },
    [detailsByPr, expandedPr, repoOptions],
  );

  const totalPages = Math.max(1, Math.ceil(result.totalRows / result.pageSize));
  const currentPage = Math.min(result.page, totalPages);

  // Daily count line derived from the bounded PR series (newest 500 PRs).
  const dailyCounts = useMemo(() => {
    if (result.tab !== 'pr') return [];
    const byDate = new Map<string, number>();
    for (const point of result.series) {
      byDate.set(point.date, (byDate.get(point.date) ?? 0) + 1);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }, [result]);

  const chartData = useMemo(
    () => {
      if (result.tab !== 'pr') return [];
      return result.series.map((p) => ({
        label: `#${p.prNumber}`,
        queue: p.queue,
        ciRuntime: p.ciRuntime,
        review: p.review,
        repoKey: p.repoKey,
        prNumber: p.prNumber,
      }));
    },
    [result],
  );

  return (
    <div className="min-h-screen bg-neutral-50 p-4 font-sans text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 md:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col space-y-6">
        <header className="flex items-center gap-2 rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <Activity className="text-blue-500 dark:text-blue-400" />
          <h1 className="text-2xl font-bold">Action Insight</h1>
          <span className="ml-auto text-sm text-neutral-400 dark:text-neutral-500">
            Attempt-scoped CI analytics
          </span>
        </header>

        {/* Fixed filter toolbar */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-100 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center gap-2">
            <label htmlFor="repo-select" className="whitespace-nowrap text-sm text-neutral-500 dark:text-neutral-400">
              Repository
            </label>
            <select
              id="repo-select"
              value={selectedRepoKey}
              onChange={(e) => setSelectedRepoKey(e.target.value)}
              className="min-w-48 rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
            >
              <option value="">All repositories</option>
              {repoOptions.map((repo) => (
                <option key={repo.key} value={repo.key}>{repo.key}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            {[1, 7, 14, 30].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setUseCustomRange(false);
                  setDays(value);
                }}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-all ${
                  days === value && !useCustomRange
                    ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                    : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'
                }`}
              >
                {value}d
              </button>
            ))}
            <button
              type="button"
              onClick={() => setUseCustomRange(true)}
              className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-all ${
                useCustomRange
                  ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400'
              }`}
            >
              <CalendarIcon className="h-3 w-3" /> Custom
            </button>
            {useCustomRange && (
              <div className="flex items-center gap-1 rounded-md border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-transparent px-1 py-0.5 text-xs text-neutral-700 outline-none dark:text-neutral-300"
                />
                <span className="text-neutral-400">-</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-transparent px-1 py-0.5 text-xs text-neutral-700 outline-none dark:text-neutral-300"
                />
              </div>
            )}
          </div>
        </div>

        {/* Five-tab nav (PR + Cost active; others stubbed for later slices) */}
        <div className="flex rounded-lg border border-neutral-100 bg-white p-1 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          {TABS.map((tab) => {
            const active = tab.key === activeTab;
            const enabled =
              tab.key === 'pr' ||
              tab.key === 'cost' ||
              tab.key === 'workflow' ||
              tab.key === 'job' ||
              tab.key === 'queue';
            return (
              <button
                key={tab.key}
                type="button"
                disabled={!enabled}
                onClick={() =>
                  enabled &&
                  switchTab(
                    tab.key as 'pr' | 'cost' | 'workflow' | 'job' | 'queue',
                  )
                }
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400'
                    : 'text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 disabled:cursor-not-allowed'
                }`}
                title={
                  tab.key === 'pr'
                    ? 'PR lifecycle analysis'
                    : tab.key === 'cost'
                      ? 'Machine-Hours cost analysis'
                      : tab.key === 'workflow'
                        ? 'Workflow attempt analysis'
                        : tab.key === 'job'
                          ? 'Job-level analysis'
                          : tab.key === 'queue'
                            ? 'Queue duration analysis'
                            : 'Coming in a later slice'
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {result.tab === 'pr' && (
        <>
        {/* PR metric cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="PR End-to-End"
            definition="Queue + CI runtime + review, for merged PRs with all three valid parts (spec §4)."
            stats={result.cards.endToEnd}
          />
          <StatCard
            label="PR CI Runtime"
            definition="First tracked CI start → last tracked CI completion."
            stats={result.cards.ciRuntime}
          />
          <StatCard
            label="PR Review"
            definition="Last tracked CI completion → PR merge. Negative samples excluded."
            stats={result.cards.review}
          />
          <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Forced Merge Rate
              <MetricTooltip definition="Share of eligible merged PRs merged before tracked CI completed (spec §4)." />
            </div>
            <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
              {result.cards.mergedPrCount > 0
                ? `${Math.round(result.cards.forcedMergeRate)}%`
                : '—'}
            </div>
            <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              {result.cards.eligibleForcedMergeCount} eligible
            </div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Merged PRs
            </div>
            <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
              {result.cards.mergedPrCount}
            </div>
            <div className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">in range</div>
          </div>
        </div>

        {/* Data-quality / truncation notices */}
        {result.truncated && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            Showing latest {result.displayedObservationCount} of {result.cards.mergedPrCount} observations — narrow the date range to see all.
          </div>
        )}
        {result.quality.invalidTimingSamples > 0 && (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
            {result.quality.invalidTimingSamples} PR(s) with invalid/missing timing excluded from duration metrics.
            {result.quality.partialHistorySamples > 0 &&
              ` ${result.quality.partialHistorySamples} with partial CI history.`}
          </div>
        )}

        {/* Chart: stacked bar per PR + daily count line */}
        <div className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="mb-4 text-lg font-bold">PR Timing Breakdown</h2>
          {chartData.length === 0 ? (
            <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              No merged PRs in the selected range.
            </div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" className="dark:opacity-20" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="seconds" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    formatter={(value, name) => [
                      name === 'PR count' ? value : fmtSeconds(Number(value)),
                      String(name),
                    ]}
                  />
                  <Legend />
                  <Bar yAxisId="seconds" dataKey="queue" name="Queue" stackId="a" fill="#60a5fa" />
                  <Bar yAxisId="seconds" dataKey="ciRuntime" name="CI Runtime" stackId="a" fill="#34d399" />
                  <Bar yAxisId="seconds" dataKey="review" name="Review" stackId="a" fill="#fbbf24" />
                  <Line
                    yAxisId="count"
                    type="monotone"
                    data={dailyCounts}
                    dataKey="count"
                    name="PR count"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Paged detail table */}
        <div className="overflow-hidden rounded-xl border border-neutral-100 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="border-b border-neutral-100 p-4 dark:border-neutral-800">
            <h2 className="text-lg font-bold">Merged PRs</h2>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              {result.displayedObservationCount} observation(s){result.truncated ? ' (truncated)' : ''}.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                <tr>
                  <th className="px-4 py-3">Repo</th>
                  <th className="px-4 py-3">PR</th>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Queue</th>
                  <th className="px-4 py-3">CI Runtime</th>
                  <th className="px-4 py-3">Review</th>
                  <th className="px-4 py-3">Merged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {result.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                      No merged PRs in range. {selectedRepo ? 'Try “All repositories” or a wider range.' : ''}
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row: PrTableRow) => {
                    const key = `${row.repoKey}:${row.prNumber}`;
                    const isOpen = expandedPr === key;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-950/60"
                          onClick={() => loadDetail(row.repoKey, row.prNumber)}
                        >
                          <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">{row.repoKey}</td>
                          <td className="px-4 py-3">
                            <a
                              href={row.htmlUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                              onClick={(e) => e.stopPropagation()}
                            >
                              #{row.prNumber}
                            </a>
                          </td>
                          <td className="px-4 py-3 max-w-xs truncate" title={row.title}>{row.title}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.queue)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtSeconds(row.ciRuntime)}</td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {fmtSeconds(row.review)}
                            {row.forcedMerge && (
                              <span className="ml-1 text-red-500" title="Merged before CI completed">⚠</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">
                            {row.mergedAt ? format(parseISO(row.mergedAt), 'MMM dd HH:mm') : '—'}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="bg-neutral-50/50 dark:bg-neutral-950/40">
                              <PrDrillDown
                                detail={detailsByPr[key]}
                                loading={loadingDetail === key}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {result.totalRows > result.pageSize && (
            <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Page {currentPage} of {totalPages} · {result.totalRows} rows
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => pushPage(currentPage - 1)}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => pushPage(currentPage + 1)}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
        </>
        )}

        {result.tab === 'cost' && (
          <CostBody result={result} />
        )}

        {result.tab === 'workflow' && (
          <WorkflowBody result={result} repoOptions={repoOptions} />
        )}

        {result.tab === 'job' && (
          <JobBody result={result} repoOptions={repoOptions} />
        )}

        {result.tab === 'queue' && (
          <QueueBody result={result} repoOptions={repoOptions} />
        )}

        <footer className="pb-4 text-center text-xs text-neutral-400 dark:text-neutral-600">
          Metrics computed server-side from attempt-scoped PostgreSQL data (ADR-008). No GitHub API calls on dashboard reads.
        </footer>
      </div>
    </div>
  );

  function pushPage(page: number) {
    const params = new URLSearchParams(urlSearchParams.toString());
    params.set('page', String(page));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }
}
