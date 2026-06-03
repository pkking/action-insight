'use client';

import React, { useId, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  AlignLeft,
  ArrowLeft,
  Calendar as CalendarIcon,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
  ExternalLink,
  Filter,
  Info,
  LayoutList,
  MessageSquare,
  Minus,
  Monitor,
  Plus,
  Share2,
  TestTube,
  XCircle,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import type { LegendPayload } from 'recharts';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';

import { buildDailyTrend, buildRepoOverviewRows, createDateRange, filterByDateRange } from '@/lib/overview-metrics';
import { diffSeconds } from '@/lib/time-utils';
import { callApi } from '@/lib/api-client';
import type { RepoOption } from '@/lib/server-homepage-data';
import type {
  DailyTrendPoint,
  DateRange,
  PullRequestDetailFile,
  PullRequestIndexFile,
  RepoOverviewRow,
  Run,
  TestCaseStats,
} from '@/lib/types';

type JobSortField = 'queue' | 'duration' | 'name';
type JobSummarySortField = 'name' | 'p90E2e' | 'p50E2e' | 'successRate' | 'p90Queue';
type WorkflowSortField = 'date' | 'duration' | 'name' | 'p90' | 'p50' | 'successRate';
type WorkflowSortOrder = 'asc' | 'desc' | 'none';
type PrLifecycleViewMode = 'pr' | 'workflow' | 'job' | 'event';
type WorkflowTimingData = {
  id: number;
  name: string;
  queueTimeSeconds: number | undefined;
  e2eTimeSeconds: number;
  conclusion: string;
  created_at: string;
};
type WorkflowSummary = {
  name: string;
  runCount: number;
  successCount: number;
  successRate: number;
  p50Duration: number;
  p90Duration: number;
  debugInfo: string;
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
type JobSummary = {
  name: string;
  runCount: number;
  successCount: number;
  successRate: number;
  p50Queue: number;
  p90Queue: number;
  p50E2e: number;
  p90E2e: number;
  debugInfo: string;
};
type MetricKey = 'prE2EP90Minutes' | 'ciE2EP90Minutes' | 'reviewP90Minutes' | 'ciE2ESlaRate';
type DashboardQueryState = {
  days: number;
  startDate: string;
  endDate: string;
  useCustomRange: boolean;
  filterName: string;
  repoKey: string;
  jobName: string;
};

type DashboardClientProps = {
  initialFailedRepoKeys: string[];
  initialRepoIndexesByKey: Record<string, PullRequestIndexFile>;
  initialRepoOptions: RepoOption[];
  initialTestCaseStatsByKey: Record<string, TestCaseStats | null>;
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

const METRIC_DEFINITIONS: Record<MetricKey, string> = {
  prE2EP90Minutes: 'P90 (90th percentile) time from PR creation to merge — 90% of PRs merge faster than this value.',
  ciE2EP90Minutes: 'P90 (90th percentile) CI end-to-end duration — 90% of PRs complete CI faster than this value.',
  reviewP90Minutes: 'P90 (90th percentile) merge lead time — time from CI completion to PR merge. 90% of PRs merge faster than this value after CI passes.',
  ciE2ESlaRate: 'CI SLA compliance rate — percentage of PRs where CI completed within 1 hour.',
};

function MetricTooltip({ definition }: { definition: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const tooltipId = useId();

  return (
    <span className="group relative inline-flex">
      <span
        role="button"
        tabIndex={0}
        aria-label="Metric definition"
        aria-describedby={isOpen ? tooltipId : undefined}
        onClick={() => setIsOpen((v) => !v)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsOpen(false);
        }}
        className="inline-flex cursor-help items-center justify-center rounded-full bg-neutral-200 text-[10px] font-bold leading-none text-neutral-500 hover:bg-neutral-300 hover:text-neutral-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600 dark:hover:text-neutral-100"
        style={{ width: '14px', height: '14px' }}
      >
        ?
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-700 shadow-md transition-opacity dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${
          isOpen ? 'pointer-events-auto opacity-100' : 'opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
        }`}
      >
        {definition}
      </span>
    </span>
  );
}

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

function computePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, index)] ?? 0;
}

type TimeStats = { avg: number; p50: number; p90: number };

function computeTimeStats(values: number[]): TimeStats | null {
  if (values.length < 2) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: sum / values.length,
    p50: computePercentile(sorted, 0.5),
    p90: computePercentile(sorted, 0.9),
  };
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
    jobName: params.get('jobName') || '',
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
    for (const job of run.jobs) {
      jobs.push({
        id: job.id,
        name: job.name,
        workflowName: run.name,
        workflowId: run.id,
        queueTimeSeconds: job.queueDurationInSeconds,
        e2eTimeSeconds: job.durationInSeconds,
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

type PrLifecycleTimelineData = {
  number?: number;
  created_at: string;
  ci_started_at?: string;
  ci_completed_at?: string;
  merged_at?: string;
  workflows: Run[];
};

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

function formatDurationShort(ms: number): string {
  return formatDuration(Math.round(ms / 1000));
}

function getStepDurationSeconds(step: { started_at?: string; completed_at?: string; duration_seconds?: number }): number {
  return step.duration_seconds ?? diffSeconds(step.started_at, step.completed_at, { clampNegative: true }) ?? 0;
}

function conclusionBadgeBg(conclusion: string): string {
  switch (conclusion) {
    case 'success':
      return 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'skipped':
      return 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
    case 'failure':
    case 'cancelled':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
  }
}

function nodeIndent(depth: number): string {
  const map: Record<number, string> = { 0: 'pl-2', 1: 'pl-6', 2: 'pl-10', 3: 'pl-14' };
  return map[depth] ?? 'pl-14';
}

interface TreeNodeCardProps {
  depth: number;
  icon: React.ReactNode;
  label: string;
  duration: string;
  conclusion: string;
  expanded: boolean;
  hasChildren: boolean;
  onToggle?: () => void;
  href?: string;
  typeLabel?: 'PR' | 'Workflow' | 'Job' | 'Step' | 'Event';
}

function TreeNodeCard({ depth, icon, label, duration, conclusion, expanded, hasChildren, onToggle, href, typeLabel }: TreeNodeCardProps) {
  const badgeClasses = conclusionBadgeBg(conclusion);
  const isClickable = hasChildren && onToggle;

  const card = (
    <div
      className={`group relative min-w-0 rounded-lg border px-3 py-2.5 transition-colors ${
        isClickable ? 'cursor-pointer border-neutral-200 bg-white hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800' : 'border-neutral-100 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/50'
      }`}
      onClick={isClickable ? onToggle : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onToggle?.(); } : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Expand/Collapse chevron */}
        <span className="flex w-4 shrink-0 items-center justify-center text-neutral-400">
          {hasChildren ? (
            expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <span className="h-1 w-1 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          )}
        </span>

        {/* Icon */}
        <span className="flex shrink-0 items-center text-sm">{icon}</span>

        {/* Label */}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-xs font-medium text-neutral-800 hover:underline dark:text-neutral-200" title={label}>
            {label}
          </a>
        ) : (
          <span className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-200" title={label}>
            {label}
          </span>
        )}

        {/* Type badge */}
        {typeLabel && (
          <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {typeLabel}
          </span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Duration */}
        <span className="shrink-0 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{duration}</span>

        {/* Status badge */}
        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeClasses}`}>
          {conclusion === 'success' && <CheckCircle className="h-3 w-3" />}
          {conclusion === 'failure' && <XCircle className="h-3 w-3" />}
          {conclusion === 'cancelled' && <XCircle className="h-3 w-3" />}
          {conclusion === 'skipped' && <Info className="h-3 w-3" />}
          {!['success', 'failure', 'cancelled', 'skipped'].includes(conclusion) && <span className="h-2 w-2 rounded-full bg-amber-400" />}
          <span className="capitalize">{conclusion || 'pending'}</span>
        </span>
      </div>
    </div>
  );

  return (
    <div className={`relative min-w-0 py-1 ${nodeIndent(depth)}`}>
      {/* Tree connector lines for all ancestor levels */}
      {Array.from({ length: depth }).map((_, ancestor) => (
        <div
          key={ancestor}
          className="pointer-events-none absolute left-0 top-0 bottom-0 w-px bg-neutral-200 dark:bg-neutral-700"
          style={{ marginLeft: `${18 + ancestor * 16}px` }}
        />
      ))}
      {card}
    </div>
  );
}

function PrLifecycleTree({ data, showPrRoot = true }: { data: PrLifecycleTimelineData; showPrRoot?: boolean }) {
  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<Set<number>>(new Set());
  const [expandedJobIds, setExpandedJobIds] = useState<Set<number>>(new Set());

  // Compute PR-level total time: from PR creation to the latest event (merge or last workflow end)
  const { prTotalMs, isForceMerged, forceMergeGap } = useMemo(() => {
    const prCreatedMs = new Date(data.created_at).getTime();
    let endMs = prCreatedMs;

    if (data.ci_completed_at) endMs = Math.max(endMs, new Date(data.ci_completed_at).getTime());
    if (data.merged_at) endMs = Math.max(endMs, new Date(data.merged_at).getTime());

    for (const wf of data.workflows) {
      const wfEnd = new Date(wf.created_at).getTime() + wf.durationInSeconds * 1000;
      endMs = Math.max(endMs, wfEnd);
    }

    const forceMerged = Boolean(data.merged_at && data.ci_completed_at && data.merged_at < data.ci_completed_at);
    const gap = forceMerged ? (new Date(data.ci_completed_at!).getTime() - new Date(data.merged_at!).getTime()) / 1000 : 0;

    return { prTotalMs: endMs - prCreatedMs, isForceMerged: forceMerged, forceMergeGap: gap };
  }, [data]);

  const toggleWorkflow = (id: number) => {
    setExpandedWorkflowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleJob = (id: number) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandAllWorkflows = () => {
    setExpandedWorkflowIds(new Set(data.workflows.map((wf) => wf.id)));
  };

  const collapseAll = () => {
    setExpandedWorkflowIds(new Set());
    setExpandedJobIds(new Set());
  };

  return (
    <div className="max-h-[600px] min-w-0 overflow-y-auto pr-1 space-y-2">
      {/* Toolbar — sticky relative to the scrollable parent */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/90">
        <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">CI Breakdown</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={data.workflows.length === 0}
              onClick={expandedWorkflowIds.size > 0 ? collapseAll : expandAllWorkflows}
              className="inline-flex items-center justify-center rounded-md border border-neutral-200 p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              aria-label={expandedWorkflowIds.size > 0 ? 'Collapse all' : 'Expand all'}
            >
              {expandedWorkflowIds.size > 0 ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

      {/* PR Root Node */}
      {showPrRoot && (
      <TreeNodeCard
        depth={0}
        icon={<span className="text-blue-500">📝</span>}
        label={`PR #${data.number ?? '?'}`}
        duration={formatDurationShort(prTotalMs)}
        conclusion={data.merged_at ? 'success' : data.ci_completed_at ? 'success' : 'pending'}
        expanded={data.workflows.length > 0}
        hasChildren={data.workflows.length > 0}
        typeLabel="PR"
      />
      )}

      {/* Workflows */}
      {data.workflows.length === 0 ? (
        <div className="pl-6 rounded-lg border border-dashed border-neutral-200 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
          No workflows found for this PR.
        </div>
      ) : (
        <div className="relative">
          {data.workflows.map((wf) => {
            const isWfExpanded = expandedWorkflowIds.has(wf.id);
            const jobs = wf.jobs || [];

            return (
              <div key={wf.id} className="relative">
                {/* Workflow Node */}
                <TreeNodeCard
                  depth={showPrRoot ? 1 : 0}
                  icon={<span className="text-teal-500">⚡</span>}
                  label={wf.name}
                  duration={formatDuration(wf.durationInSeconds)}
                  conclusion={wf.conclusion}
                  expanded={isWfExpanded}
                  hasChildren={jobs.length > 0}
                  onToggle={() => toggleWorkflow(wf.id)}
                  href={wf.html_url}
                  typeLabel="Workflow"
                />

                {/* Jobs */}
                {isWfExpanded && jobs.length > 0 && (
                  <div className="relative">
                    {jobs.map((job) => {
                      const isJobExpanded = expandedJobIds.has(job.id);
                      const steps = job.steps || [];

                      return (
                        <div key={job.id} className="relative">
                          {/* Job Node */}
                          <TreeNodeCard
                            depth={showPrRoot ? 2 : 1}
                            icon={<span className="text-purple-500">🔧</span>}
                            label={job.name}
                            duration={formatDuration(job.durationInSeconds)}
                            conclusion={job.conclusion}
                            expanded={isJobExpanded}
                            hasChildren={steps.length > 0}
                            onToggle={steps.length > 0 ? () => toggleJob(job.id) : undefined}
                            href={job.html_url}
                            typeLabel="Job"
                          />

                          {/* Steps */}
                          {isJobExpanded && steps.length > 0 && (
                            <div className="relative">
                              {steps.map((step) => (
                                <TreeNodeCard
                                  key={step.number}
                                  depth={showPrRoot ? 3 : 2}
                                  icon={<span className="text-amber-500">▸</span>}
                                  label={step.name}
                                  duration={formatDuration(getStepDurationSeconds(step))}
                                  conclusion={step.conclusion}
                                  expanded={false}
                                  hasChildren={false}
                                  typeLabel="Step"
                                />
                              ))}
                            </div>
                          )}

                          {/* Step placeholder when no step data available */}
                          {isJobExpanded && steps.length === 0 && (
                            <div className={`${nodeIndent(showPrRoot ? 3 : 2)} py-1`}>
                              <div className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-200 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                                <Info className="h-3 w-3" />
                                <span>Step details not available — run ETL with step collection to enable this view.</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Force merge warning — always visible regardless of showPrRoot */}
      {isForceMerged && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
          <XCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Force merged — PR was merged before CI completed. CI ended {formatDuration(forceMergeGap)} after merge.</span>
        </div>
      )}
    </div>
  );
}

type EventGroup = {
  eventType: string;
  workflows: Run[];
  totalCount: number;
  successCount: number;
  totalDurationSeconds: number;
};

const EVENT_LABELS: Record<string, { label: string; icon: string }> = {
  push: { label: 'Push', icon: '🔀' },
  pull_request: { label: 'Pull Request', icon: '📝' },
  pull_request_review: { label: 'PR Review', icon: '👁️' },
  pull_request_target: { label: 'PR Target', icon: '🎯' },
  schedule: { label: 'Scheduled', icon: '⏰' },
  workflow_dispatch: { label: 'Manual Dispatch', icon: '🖱️' },
  issue_comment: { label: 'Issue Comment', icon: '💬' },
  issues: { label: 'Issues', icon: '🐛' },
  release: { label: 'Release', icon: '🏷️' },
  create: { label: 'Branch/Tag Created', icon: '🌿' },
  merge_group: { label: 'Merge Group', icon: '🔗' },
};

function getEventIcon(eventType: string): string {
  return EVENT_LABELS[eventType]?.icon ?? '⚡';
}

function getEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType]?.label ?? eventType;
}

function groupWorkflowsByEvent(runs: Run[]): EventGroup[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const type = run.event || 'unknown';
    const existing = groups.get(type) || [];
    existing.push(run);
    groups.set(type, existing);
  }

  return Array.from(groups.entries())
    .map(([eventType, workflows]) => ({
      eventType,
      workflows,
      totalCount: workflows.length,
      successCount: workflows.filter((w) => w.conclusion === 'success').length,
      totalDurationSeconds: workflows.reduce((sum, w) => sum + w.durationInSeconds, 0),
    }))
    .sort((a, b) => b.totalCount - a.totalCount);
}

function EventsTreeView({ allWorkflows, filterName }: { allWorkflows: Run[]; filterName: string }) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [expandedWorkflowIds, setExpandedWorkflowIds] = useState<Set<number>>(new Set());
  const [expandedJobIds, setExpandedJobIds] = useState<Set<number>>(new Set());
  const [eventSortOrder, setEventSortOrder] = useState<'count' | 'duration' | 'name'>('count');

  const eventGroups = useMemo(() => {
    let filtered = allWorkflows;
    if (filterName) {
      const query = filterName.toLowerCase();
      filtered = filtered.filter(
        (run) =>
          `${run.name} ${run.head_branch} ${run.event ?? ''}`.toLowerCase().includes(query)
      );
    }
    return groupWorkflowsByEvent(filtered);
  }, [allWorkflows, filterName]);

  const sortedGroups = useMemo(() => {
    const sorted = [...eventGroups];
    if (eventSortOrder === 'count') sorted.sort((a, b) => b.totalCount - a.totalCount);
    else if (eventSortOrder === 'duration') sorted.sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
    else if (eventSortOrder === 'name') sorted.sort((a, b) => a.eventType.localeCompare(b.eventType));
    return sorted;
  }, [eventGroups, eventSortOrder]);

  const toggleEvent = (eventType: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventType)) next.delete(eventType); else next.add(eventType);
      return next;
    });
  };

  const toggleWorkflow = (id: number) => {
    setExpandedWorkflowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleJob = (id: number) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandAllEvents = () => {
    setExpandedEvents(new Set(sortedGroups.map((g) => g.eventType)));
  };

  const collapseAll = () => {
    setExpandedEvents(new Set());
    setExpandedWorkflowIds(new Set());
    setExpandedJobIds(new Set());
  };

  if (eventGroups.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
        No workflow runs found for the selected date range.
      </div>
    );
  }

  return (
    <div className="max-h-[600px] min-w-0 overflow-y-auto pr-1 space-y-2">
      {/* Toolbar — sticky relative to the scrollable parent */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/90">
        <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
          Events Breakdown ({eventGroups.length} event types, {allWorkflows.length} runs)
        </span>
          <div className="flex items-center gap-3">
            <select
              value={eventSortOrder}
              onChange={(e) => setEventSortOrder(e.target.value as 'count' | 'duration' | 'name')}
              className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-[10px] text-neutral-700 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
            >
              <option value="count">Sort by Count</option>
              <option value="duration">Sort by Duration</option>
              <option value="name">Sort by Name</option>
            </select>
            <button
              type="button"
              disabled={sortedGroups.length === 0}
              onClick={expandedEvents.size > 0 ? collapseAll : expandAllEvents}
              className="inline-flex items-center justify-center rounded-md border border-neutral-200 p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              aria-label={expandedEvents.size > 0 ? 'Collapse all' : 'Expand all'}
            >
              {expandedEvents.size > 0 ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

      {/* Event groups */}
      {sortedGroups.map((group) => {
        const isEventExpanded = expandedEvents.has(group.eventType);
        const successRate = group.totalCount > 0 ? Math.round((group.successCount / group.totalCount) * 100) : 0;

        return (
          <div key={group.eventType} className="relative">
            {/* Event Root Node */}
            <TreeNodeCard
              depth={0}
              icon={<span>{getEventIcon(group.eventType)}</span>}
              label={`${getEventLabel(group.eventType)} (${group.eventType})`}
              duration={formatDuration(group.totalDurationSeconds)}
              conclusion={successRate >= 80 ? 'success' : successRate >= 50 ? 'pending' : 'failure'}
              expanded={isEventExpanded}
              hasChildren={group.workflows.length > 0}
              onToggle={() => toggleEvent(group.eventType)}
              typeLabel="Event"
            />

            {/* Summary row under event */}
            {isEventExpanded && (
              <div className="pl-2 py-0.5">
                <div className="flex items-center gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
                  <span>{group.totalCount} runs</span>
                  <span className="text-green-600 dark:text-green-400">{group.successCount} success</span>
                  <span className="text-neutral-400 dark:text-neutral-500">{successRate}% success rate</span>
                </div>
              </div>
            )}

            {/* Workflows under event */}
            {isEventExpanded && (
              <div className="relative">
                {group.workflows
                  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                  .map((wf) => {
                    const isWfExpanded = expandedWorkflowIds.has(wf.id);
                    const jobs = wf.jobs || [];

                    return (
                      <div key={wf.id} className="relative">
                        {/* Workflow Node */}
                        <TreeNodeCard
                          depth={1}
                          icon={<span className="text-teal-500">⚡</span>}
                          label={wf.name}
                          duration={formatDuration(wf.durationInSeconds)}
                          conclusion={wf.conclusion}
                          expanded={isWfExpanded}
                          hasChildren={jobs.length > 0}
                          onToggle={() => toggleWorkflow(wf.id)}
                          href={wf.html_url}
                          typeLabel="Workflow"
                        />

                        {/* Branch & time info */}
                        {isWfExpanded && (
                          <div className="pl-6 py-0.5">
                            <div className="flex items-center gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
                              <span className="font-mono">{wf.head_branch}</span>
                              <span>{format(new Date(wf.created_at), 'MMM dd HH:mm')}</span>
                            </div>
                          </div>
                        )}

                        {/* Jobs */}
                        {isWfExpanded && jobs.length > 0 && (
                          <div className="relative">
                            {jobs.map((job) => {
                              const isJobExpanded = expandedJobIds.has(job.id);
                              const steps = job.steps || [];

                              return (
                                <div key={job.id} className="relative">
                                  {/* Job Node */}
                                  <TreeNodeCard
                                    depth={2}
                                    icon={<span className="text-purple-500">🔧</span>}
                                    label={job.name}
                                    duration={formatDuration(job.durationInSeconds)}
                                    conclusion={job.conclusion}
                                    expanded={isJobExpanded}
                                    hasChildren={steps.length > 0}
                                    onToggle={steps.length > 0 ? () => toggleJob(job.id) : undefined}
                                    href={job.html_url}
                                    typeLabel="Job"
                                  />

                                  {/* Steps */}
                                  {isJobExpanded && steps.length > 0 && (
                                    <div className="relative">
                                      {steps.map((step) => (
                                        <TreeNodeCard
                                          key={step.number}
                                          depth={3}
                                          icon={<span className="text-amber-500">▸</span>}
                                          label={step.name}
                                          duration={formatDuration(getStepDurationSeconds(step))}
                                          conclusion={step.conclusion}
                                          expanded={false}
                                          hasChildren={false}
                                          typeLabel="Step"
                                        />
                                      ))}
                                    </div>
                                  )}

                                  {isJobExpanded && steps.length === 0 && (
                                    <div className="pl-14 py-1">
                                      <div className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-200 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                                        <Info className="h-3 w-3" />
                                        <span>Step details not available.</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })}
    </div>
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

function JobDetailView({
  jobName,
  allWorkflows,
  dateRange,
  onBack,
}: {
  jobName: string;
  allWorkflows: Run[];
  dateRange: DateRange;
  onBack: () => void;
}) {
  const [showDailyTrend, setShowDailyTrend] = useState(true);
  const [showIndividualRuns, setShowIndividualRuns] = useState(true);

  const chartData = useMemo(() => {
    const matchingJobs: {
      day: string;
      dayIndex: number;
      queueSeconds: number;
      e2eSeconds: number;
      conclusion: string;
      created_at: string;
    }[] = [];

    for (const run of allWorkflows) {
      if (!run.jobs) continue;
      const runCreatedAtMs = new Date(run.created_at).getTime();
      const runDate = new Date(run.created_at);
      const dayStr = format(runDate, 'yyyy-MM-dd');
      const dayIndex = differenceInCalendarDays(runDate, dateRange.start);

      for (const job of run.jobs) {
        if (job.name !== jobName) continue;
        if (!job.started_at && !job.created_at) continue;
        const startedAtMs = new Date(job.started_at || job.created_at).getTime();
        const completedAtMs = new Date(job.completed_at || job.started_at || job.created_at).getTime();
        const queueSeconds = Math.max(0, (startedAtMs - runCreatedAtMs) / 1000);
        const e2eSeconds = Math.max(0, (completedAtMs - runCreatedAtMs) / 1000);
        matchingJobs.push({ day: dayStr, dayIndex, queueSeconds, e2eSeconds, conclusion: job.conclusion, created_at: run.created_at });
      }
    }

    if (matchingJobs.length === 0) return null;

    const byDay = new Map<string, typeof matchingJobs>();
    for (const job of matchingJobs) {
      const existing = byDay.get(job.day) || [];
      existing.push(job);
      byDay.set(job.day, existing);
    }

    const dailyRows: Record<string, unknown>[] = [];
    const sortedDays = [...byDay.keys()].sort();

    const p90 = (values: number[]) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.ceil(sorted.length * 0.9) - 1] ?? 0;
    };

    for (const day of sortedDays) {
      const dayJobs = byDay.get(day)!;
      const queueValues = dayJobs.map((j) => j.queueSeconds);
      const e2eValues = dayJobs.map((j) => j.e2eSeconds);
      const successCount = dayJobs.filter((j) => j.conclusion === 'success').length;
      dailyRows.push({
        day,
        p90Queue: p90(queueValues),
        p90E2e: p90(e2eValues),
        successRate: Math.round((successCount / dayJobs.length) * 100),
        runCount: dayJobs.length,
        dayIndex: dayJobs[0].dayIndex,
      });
    }

    // Group scatter data by conclusion to minimize <Scatter> components
    const scatterByConclusion = new Map<string, { x: number; y: number }[]>();
    for (const job of matchingJobs) {
      const seed = job.created_at.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) + job.conclusion.charCodeAt(0);
      const jitter = ((seed * 9301 + 49297) % 233280) / 233280 * 0.6 - 0.3;
      const group = scatterByConclusion.get(job.conclusion) || [];
      group.push({ x: job.dayIndex + jitter, y: job.e2eSeconds });
      scatterByConclusion.set(job.conclusion, group);
    }

    return { dailyRows, scatterByConclusion };
  }, [allWorkflows, jobName, dateRange.start]);

  if (!chartData) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to jobs
          </button>
          <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">{jobName}</h3>
        </div>
        <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
          No runs found for this job in the selected time range.
        </div>
      </div>
    );
  }

  const { dailyRows, scatterByConclusion } = chartData;

  const conclusionColor = (conclusion: string) => {
    if (conclusion === 'success') return '#22c55e';
    if (conclusion === 'skipped') return '#9ca3af';
    return '#ef4444';
  };

  const conclusionLabel = (conclusion: string) => {
    if (conclusion === 'success') return 'Success';
    if (conclusion === 'skipped') return 'Skipped';
    return 'Failed';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to jobs
        </button>
        <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">{jobName}</h3>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="inline-flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={showDailyTrend}
            onChange={(e) => setShowDailyTrend(e.target.checked)}
            className="rounded border-neutral-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-600"
          />
          Show daily trend
        </label>
        <label className="inline-flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={showIndividualRuns}
            onChange={(e) => setShowIndividualRuns(e.target.checked)}
            className="rounded border-neutral-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-600"
          />
          Show individual runs
        </label>
      </div>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={showDailyTrend ? dailyRows : []}>
            <XAxis
              type="number"
              dataKey="dayIndex"
              tick={{ fontSize: 11, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              ticks={dailyRows.map((r) => r.dayIndex as number)}
              tickFormatter={(val) => {
                const row = dailyRows.find((r) => r.dayIndex === val);
                return row ? format(parseISO(row.day as string), 'MMM dd') : '';
              }}
              angle={-30}
              textAnchor="end"
              height={50}
              domain={['dataMin - 0.5', 'dataMax + 0.5']}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 12, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `${Math.round(val / 60)}`}
              label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#888' }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
            />
            <Tooltip content={({ payload, label }) => {
              if (!payload || payload.length === 0) return null;
              return (
                <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs shadow-md dark:border-neutral-700 dark:bg-neutral-800">
                  <div className="mb-1.5 font-medium text-neutral-700 dark:text-neutral-200">{label}</div>
                  <div className="space-y-0.5">
                    {payload.map((entry, i) => {
                      const { dataKey, value, color, name } = entry;
                      const displayValue = dataKey === 'p90Queue' || dataKey === 'p90E2e'
                        ? `${Math.round(Number(value) / 60)}m`
                        : dataKey === 'successRate'
                          ? `${value}%`
                          : String(value);
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                          <span className="text-neutral-500 dark:text-neutral-400">{name}:</span>
                          <span className="font-mono text-neutral-700 dark:text-neutral-200">{displayValue}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }} />
            <Legend />
            {showDailyTrend && (
              <>
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="p90Queue"
                  name="P90 Queue"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="p90E2e"
                  name="P90 E2E"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="successRate"
                  name="Success Rate"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                />
                <Bar yAxisId="right" dataKey="runCount" name="Run Count" fill="#9ca3af" radius={[4, 4, 0, 0]} opacity={0.5} />
              </>
            )}
            {showIndividualRuns &&
              [...scatterByConclusion.entries()].map(([conclusion, points]) => (
                <Scatter
                  key={conclusion}
                  name={conclusionLabel(conclusion)}
                  data={points}
                  fill={conclusionColor(conclusion)}
                  shape="circle"
                />
              ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface WorkflowDotProps {
  cx?: number;
  cy?: number;
  payload?: { html_url?: string };
  index?: number;
}

function CustomWorkflowDot(props: WorkflowDotProps) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload?.html_url) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill="#22c55e"
      stroke="#fff"
      strokeWidth={2}
      style={{ cursor: 'pointer' }}
      onClick={() => window.open(payload.html_url, '_blank', 'noopener,noreferrer')}
    />
  );
}

function CustomJobDot(props: WorkflowDotProps) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload?.html_url) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={6}
      fill="#3b82f6"
      stroke="#fff"
      strokeWidth={2}
      style={{ cursor: 'pointer' }}
      onClick={() => window.open(payload.html_url, '_blank', 'noopener,noreferrer')}
    />
  );
}

type JobLineChartViewProps = {
  summary: {
    name: string;
    runCount: number;
    debugInfo: string;
  };
  lineData: Array<{
    index: number;
    date: string;
    label: string;
    queueTime: number;
    e2eTime: number;
    jobId: number;
    workflowName: string;
    html_url: string;
  }>;
};

function JobLineChartView({ summary, lineData }: JobLineChartViewProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoveredPoint = hoverIndex !== null && lineData[hoverIndex] ? lineData[hoverIndex] : null;

  if (lineData.length === 0) {
    return (
      <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
        <div className="p-8 text-center text-sm text-amber-600 dark:text-amber-400">
          No successful runs for this job. Conclusion distribution: {summary.debugInfo}
        </div>
      </div>
    );
  }

  return (
    <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
      <div className="mb-3 flex items-center gap-2">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">
          {summary.name} — Run Durations
        </h4>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          ({summary.runCount} runs, {lineData.length} successful | {summary.debugInfo})
        </span>
      </div>

      {/* Hover Info Bar */}
      {hoveredPoint && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <span className="font-medium text-neutral-700 dark:text-neutral-200">{hoveredPoint.label}</span>
          <span className="text-neutral-500 dark:text-neutral-400">E2E: <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">{Math.round(hoveredPoint.e2eTime / 60)}m</span></span>
          <span className="text-neutral-500 dark:text-neutral-400">Queue: <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">{Math.round(hoveredPoint.queueTime / 60)}m</span></span>
          <span className="text-neutral-500 dark:text-neutral-400">Workflow: <span className="font-mono text-neutral-600 dark:text-neutral-400">{hoveredPoint.workflowName}</span></span>
          <a href={hoveredPoint.html_url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
            View Logs <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6" /></svg>
          </a>
        </div>
      )}

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={lineData}
            onMouseMove={(data) => {
              const idx = data?.activeIndex;
              setHoverIndex(typeof idx === 'number' ? idx : null);
            }}
            onMouseLeave={() => setHoverIndex(null)}
            onClick={(data) => {
              const idx = data?.activeIndex;
              if (typeof idx === 'number' && lineData[idx]?.html_url) {
                window.open(lineData[idx].html_url, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" className="dark:opacity-20" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              angle={-30}
              textAnchor="end"
              height={50}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 12, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `${Math.round(val / 60)}m`}
              label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#888' }}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="e2eTime"
              name="E2E Time"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={CustomJobDot}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="queueTime"
              name="Queue Time"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type WorkflowLineChartViewProps = {
  summary: {
    name: string;
    runCount: number;
    debugInfo: string;
  };
  lineData: Array<{
    index: number;
    date: string;
    label: string;
    duration: number;
    runId: number;
    html_url: string;
  }>;
};

function WorkflowLineChartView({ summary, lineData }: WorkflowLineChartViewProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoveredPoint = hoverIndex !== null && lineData[hoverIndex] ? lineData[hoverIndex] : null;

  if (lineData.length === 0) {
    return (
      <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
        <div className="p-8 text-center text-sm text-amber-600 dark:text-amber-400">
          No successful runs for this workflow. Conclusion distribution: {summary.debugInfo}
        </div>
      </div>
    );
  }

  return (
    <div className="border-l-4 border-blue-500 bg-white px-6 py-4 dark:border-blue-400 dark:bg-neutral-900">
      <div className="mb-3 flex items-center gap-2">
        <h4 className="text-sm font-bold text-neutral-700 dark:text-neutral-300">
          {summary.name} — Run Durations
        </h4>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          ({summary.runCount} runs, {lineData.length} successful | {summary.debugInfo})
        </span>
      </div>

      {/* Hover Info Bar */}
      {hoveredPoint && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <span className="font-medium text-neutral-700 dark:text-neutral-200">{hoveredPoint.label}</span>
          <span className="text-neutral-500 dark:text-neutral-400">Duration: <span className="font-mono font-semibold text-green-600 dark:text-green-400">{Math.round(hoveredPoint.duration / 60)}m</span></span>
          <a href={hoveredPoint.html_url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
            View Run <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6" /></svg>
          </a>
        </div>
      )}

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={lineData}
            onMouseMove={(data) => {
              const idx = data?.activeIndex;
              setHoverIndex(typeof idx === 'number' ? idx : null);
            }}
            onMouseLeave={() => setHoverIndex(null)}
            onClick={(data) => {
              const idx = data?.activeIndex;
              if (typeof idx === 'number' && lineData[idx]?.html_url) {
                window.open(lineData[idx].html_url, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" className="dark:opacity-20" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              angle={-30}
              textAnchor="end"
              height={50}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 12, fill: '#888' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `${Math.round(val / 60)}m`}
              domain={[0, lineData.reduce((max, d) => Math.max(max, d.duration), 60) * 1.1]}
              label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#888' }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="duration"
              name="Successful run duration"
              stroke="#22c55e"
              strokeWidth={2}
              dot={CustomWorkflowDot}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DashboardContent({
  initialFailedRepoKeys,
  initialRepoIndexesByKey,
  initialRepoOptions,
  initialTestCaseStatsByKey,
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
  const testCaseStatsByKey = initialTestCaseStatsByKey;
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
  const [selectedWorkflowSummaryName, setSelectedWorkflowSummaryName] = useState<string | null>(null);
  const [workflowSummarySortField, setWorkflowSummarySortField] = useState<'name' | 'p90' | 'p50' | 'successRate'>('p90');
  const [workflowSummarySortOrder, setWorkflowSummarySortOrder] = useState<'asc' | 'desc'>('desc');
  const [workflowDays, setWorkflowDays] = useState(30);
  const [workflowStartDate, setWorkflowStartDate] = useState('');
  const [workflowEndDate, setWorkflowEndDate] = useState('');
  const [workflowUseCustomRange, setWorkflowUseCustomRange] = useState(false);
  const [allWorkflows, setAllWorkflows] = useState<Run[]>([]);
  const [allWorkflowsLoading, setAllWorkflowsLoading] = useState(false);
  const [allWorkflowsError, setAllWorkflowsError] = useState('');
  const [jobSortField, setJobSortField] = useState<JobSortField>('duration');
  const [jobSortOrder, setJobSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedJobName, setSelectedJobName] = useState<string | null>(() => initialQuery.jobName || null);
  const [selectedJobSummaryName, setSelectedJobSummaryName] = useState<string | null>(null);
  const [jobSummarySortField, setJobSummarySortField] = useState<JobSummarySortField>('p90E2e');
  const [jobSummarySortOrder, setJobSummarySortOrder] = useState<'asc' | 'desc'>('desc');
  const [prPageSize, setPrPageSize] = useState<10 | 50 | 200>(50);
  const [prPage, setPrPage] = useState(1);
  const previousSelectedRepoKeyRef = useRef(selectedRepoKey);
  const detailAbortControllerRef = useRef<AbortController | null>(null);
  const lastWrittenUrlRef = useRef<string>('');
  const debouncedFilterName = useDebouncedValue(filterName, 250);

  const selectedRepo = useMemo(() => {
    if (repoOptions.length === 0) {
      return null;
    }

    return repoOptions.find((repo) => repo.key === selectedRepoKey) ?? repoOptions[0];
  }, [repoOptions, selectedRepoKey]);

  const workflowDateRange = useMemo(
    () => {
      const isValidDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
      return createDateRange({
        days: workflowDays,
        startDate: workflowUseCustomRange && isValidDate(workflowStartDate) ? workflowStartDate : undefined,
        endDate: workflowUseCustomRange && isValidDate(workflowEndDate) ? workflowEndDate : undefined,
        now: latestPrDate,
      });
    },
    [workflowDays, workflowEndDate, latestPrDate, workflowStartDate, workflowUseCustomRange]
  );

  const dateRange = useMemo(
    () =>
      createDateRange({
        days,
        startDate: useCustomRange ? startDate : undefined,
        endDate: useCustomRange ? endDate : undefined,
        // Always anchor to current date so newly collected runs data
        // (before PR metrics are rebuilt) is included in the date range.
        // latestPrDate could be stale if only collect.ts ran without
        // rebuild:pr-artifacts.
      }),
    [days, endDate, startDate, useCustomRange]
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
    detailAbortControllerRef.current?.abort();
    detailAbortControllerRef.current = null;
    setDetailsByNumber({});
    setLoadingDetailNumber(null);
    setExpandedPrNumber(null);
    setExpandedWorkflowId(null);
    setError('');
    setPrLifecycleViewMode('pr');
    setSelectedWorkflowIds(new Set());
    setSelectedJobIds(new Set());
    setSelectedWorkflowSummaryName(null);
    setAllWorkflows([]);
    setAllWorkflowsError('');
    setSelectedJobName(null);
    setSelectedJobSummaryName(null);
  }, [selectedRepoKey]);

  // Abort pending PR detail request on unmount
  useEffect(() => {
    return () => {
      detailAbortControllerRef.current?.abort();
    };
  }, []);

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
    if (selectedJobName) params.set('jobName', selectedJobName);

    const query = params.toString();
    const nextUrl = query ? `${pathname}?${query}` : pathname;

    // Use ref-based comparison instead of searchParams string comparison
    // to avoid infinite loops when searchParams changes identity but content is the same
    if (lastWrittenUrlRef.current === nextUrl) {
      return;
    }

    // If the URL is already correct (initial load, browser back/forward),
    // sync the ref and skip router.replace to preserve history
    const currentParams = new URLSearchParams(searchParams.toString());
    currentParams.sort();
    const targetParams = new URLSearchParams(query);
    targetParams.sort();
    if (targetParams.toString() === currentParams.toString()) {
      lastWrittenUrlRef.current = nextUrl;
      return;
    }

    lastWrittenUrlRef.current = nextUrl;
    router.replace(nextUrl, { scroll: false });
  }, [days, debouncedFilterName, endDate, pathname, router, searchParams, selectedRepo, startDate, useCustomRange, selectedJobName]);

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
    return filterByDateRange(selectedRepoPrs, workflowDateRange);
  }, [workflowDateRange, selectedRepoPrs]);

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

  // Reset page to 1 when filtered results change
  useEffect(() => {
    setPrPage(1);
  }, [filteredPrs, selectedRepoKey]);

  const paginatedPrs = useMemo(
    () => filteredPrs.slice((prPage - 1) * prPageSize, prPage * prPageSize),
    [filteredPrs, prPage, prPageSize]
  );

  const prLifecycleStats = useMemo(() => {
    if (prLifecycleViewMode !== 'pr' || filteredPrs.length === 0) return null;
    const queueTimes = filteredPrs.map((p) => p.timeToCiStartInSeconds).filter((v): v is number => v !== undefined);
    const ciDurations = filteredPrs.map((p) => p.ciDurationInSeconds).filter((v): v is number => v !== undefined);
    const mergeLeads = filteredPrs.map((p) => p.mergeLeadTimeInSeconds).filter((v): v is number => v !== undefined);
    const mergedPrs = filteredPrs.filter((p) => p.merged_at);
    const forceMergedCount = mergedPrs.filter((p) => p.ci_completed_at && p.merged_at! < p.ci_completed_at).length;
    return {
      queueStats: computeTimeStats(queueTimes),
      ciStats: computeTimeStats(ciDurations),
      mergeStats: computeTimeStats(mergeLeads),
      mergedPrCount: mergedPrs.length,
      forceMergedCount,
    };
  }, [filteredPrs, prLifecycleViewMode]);

  const shouldLoadWorkflowFallback = Boolean(
    selectedRepo && (selectedRepoMissingPrArtifact || selectedRepoHasPartialPrResolution || dateRangePrs.length === 0)
  );

  useEffect(() => {
    let cancelled = false;

    const controller = new AbortController();

    const loadFallbackRuns = async () => {
      if (!selectedRepo || !shouldLoadWorkflowFallback) {
        if (!cancelled) {
          setFallbackRuns([]);
          setFallbackRunsLoading(false);
          setFallbackRunsError('');
          setFallbackRunsScope('selected-range');
        }
        return;
      }

      setFallbackRunsLoading(true);
      setFallbackRunsError('');
      setFallbackRunsScope('selected-range');

      try {
        const runs = await callApi<Run[]>('fetchRuns', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
          startDate: format(workflowDateRange.start, 'yyyy-MM-dd'),
          endDate: format(workflowDateRange.end, 'yyyy-MM-dd'),
        }, controller.signal);

        if (cancelled) {
          return;
        }

        if (runs.length > 0) {
          setFallbackRuns(runs);
          setFallbackRunsScope('selected-range');
          return;
        }

        const latestRuns = await callApi<Run[]>('fetchLatestRuns', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
        }, controller.signal);

        if (cancelled) {
          return;
        }

        setFallbackRuns(latestRuns);
        setFallbackRunsScope(latestRuns.length > 0 ? 'latest-retained' : 'selected-range');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
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
      controller.abort();
    };
  }, [workflowDateRange.end, workflowDateRange.start, selectedRepo, shouldLoadWorkflowFallback]);

  useEffect(() => {
    let cancelled = false;

    const controller = new AbortController();

    const loadAllWorkflows = async () => {
      if (!selectedRepo || (prLifecycleViewMode !== 'workflow' && prLifecycleViewMode !== 'job' && prLifecycleViewMode !== 'event')) {
        setAllWorkflows([]);
        setAllWorkflowsLoading(false);
        setAllWorkflowsError('');
        return;
      }

      setAllWorkflowsLoading(true);
      setAllWorkflowsError('');

      try {
        const runs = await callApi<Run[]>('fetchRuns', {
          owner: selectedRepo.owner,
          repo: selectedRepo.repo,
          startDate: format(workflowDateRange.start, 'yyyy-MM-dd'),
          endDate: format(workflowDateRange.end, 'yyyy-MM-dd'),
          includeSteps: prLifecycleViewMode === 'event',
        }, controller.signal);

        if (!cancelled) {
          setAllWorkflows(runs);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
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
      controller.abort();
    };
  }, [workflowDateRange.end, workflowDateRange.start, selectedRepo, prLifecycleViewMode]);

  const unsortedFallbackRuns = useMemo(() => {
    let result = fallbackRuns;

    if (fallbackRunsScope === 'selected-range') {
      result = filterByDateRange(result, workflowDateRange);
    }

    if (filterName) {
      const query = filterName.toLowerCase();
      result = result.filter((run) => `${run.name} ${run.head_branch}`.toLowerCase().includes(query));
    }

    return result;
  }, [workflowDateRange, fallbackRuns, fallbackRunsScope, filterName]);

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

    detailAbortControllerRef.current?.abort();
    detailAbortControllerRef.current = new AbortController();
    setError('');

    setLoadingDetailNumber(number);
    try {
      const detail = await callApi<PullRequestDetailFile>('fetchPullRequestDetail', {
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        number,
      }, detailAbortControllerRef.current.signal);

      if (previousSelectedRepoKeyRef.current === selectedRepo.key) {
        setDetailsByNumber((current) => ({ ...current, [number]: detail.pr }));
        setExpandedPrNumber(number);
        setExpandedWorkflowId(null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Failed to load PR detail', err);
      setError(`Failed to load PR #${number}`);
    } finally {
      // Only clear loading if this PR is still the active loading target
      setLoadingDetailNumber((current) => current === number ? null : current);
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

  const jobSummaries = useMemo<JobSummary[]>(() => {
    const byName = new Map<string, JobTimingData[]>();
    for (const job of allJobTimingData) {
      const existing = byName.get(job.name) || [];
      existing.push(job);
      byName.set(job.name, existing);
    }

    return Array.from(byName.entries()).map(([name, jobs]) => {
      const queueDurations = jobs.map((j) => j.queueTimeSeconds).sort((a, b) => a - b);
      const e2eDurations = jobs.map((j) => j.e2eTimeSeconds).sort((a, b) => a - b);
      let successCount = 0;
      const conclusionCounts = new Map<string, number>();
      for (const job of jobs) {
        if (job.conclusion === 'success') successCount++;
        conclusionCounts.set(job.conclusion, (conclusionCounts.get(job.conclusion) || 0) + 1);
      }
      const debugInfo = [...conclusionCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
      return {
        name,
        runCount: jobs.length,
        successCount,
        successRate: jobs.length > 0 ? Math.round((successCount / jobs.length) * 100) : 0,
        p50Queue: computePercentile(queueDurations, 0.5),
        p90Queue: computePercentile(queueDurations, 0.9),
        p50E2e: computePercentile(e2eDurations, 0.5),
        p90E2e: computePercentile(e2eDurations, 0.9),
        debugInfo,
      };
    });
  }, [allJobTimingData]);

  const sortedJobSummaries = useMemo(() => {
    let sorted = [...jobSummaries];
    if (filterName) {
      const query = filterName.toLowerCase();
      sorted = sorted.filter((s) => s.name.toLowerCase().includes(query));
    }
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (jobSummarySortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'p90E2e': cmp = a.p90E2e - b.p90E2e; break;
        case 'p50E2e': cmp = a.p50E2e - b.p50E2e; break;
        case 'p90Queue': cmp = a.p90Queue - b.p90Queue; break;
        case 'successRate': cmp = a.successRate - b.successRate; break;
        default: cmp = a.runCount - b.runCount; break;
      }
      return jobSummarySortOrder === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [jobSummaries, filterName, jobSummarySortField, jobSummarySortOrder]);

  // Filter out jobs with abnormally long duration (runner timeout/disconnect)
  const MAX_REASONABLE_DURATION = 2 * 60 * 60; // 2 hours in seconds

  const jobSuccessRunLineData = useMemo(() => {
    if (!selectedJobSummaryName) return [];
    const matchingJobs = allJobTimingData.filter(
      (j) => j.name === selectedJobSummaryName && j.conclusion === 'success' && j.e2eTimeSeconds <= MAX_REASONABLE_DURATION
    );
    return matchingJobs
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((job, idx) => ({
        index: idx,
        date: job.created_at,
        label: format(new Date(job.created_at), 'MMM dd HH:mm'),
        queueTime: job.queueTimeSeconds,
        e2eTime: job.e2eTimeSeconds,
        jobId: job.id,
        workflowName: job.workflowName,
        html_url: job.html_url,
      }));
  }, [allJobTimingData, selectedJobSummaryName]);

  const handleViewModeChange = (mode: PrLifecycleViewMode) => {
    setPrLifecycleViewMode(mode);
    setSelectedWorkflowIds(new Set());
    setSelectedJobIds(new Set());
    setSelectedWorkflowSummaryName(null);
    setSelectedJobSummaryName(null);
  };

  const toggleWorkflowSummarySort = (field: 'name' | 'p90' | 'p50' | 'successRate') => {
    if (workflowSummarySortField === field) {
      setWorkflowSummarySortOrder(workflowSummarySortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setWorkflowSummarySortField(field);
      setWorkflowSummarySortOrder(field === 'name' ? 'asc' : 'desc');
    }
  };

  const workflowSummaries = useMemo<WorkflowSummary[]>(() => {
    const byName = new Map<string, Run[]>();
    for (const run of allWorkflows) {
      const existing = byName.get(run.name) || [];
      existing.push(run);
      byName.set(run.name, existing);
    }

    return Array.from(byName.entries()).map(([name, runs]) => {
      const durations = runs.map((r) => r.durationInSeconds).sort((a, b) => a - b);
      let successCount = 0;
      const conclusionCounts = new Map<string, number>();
      for (const run of runs) {
        if (run.conclusion === 'success') successCount++;
        conclusionCounts.set(run.conclusion, (conclusionCounts.get(run.conclusion) || 0) + 1);
      }
      const debugInfo = [...conclusionCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
      return {
        name,
        runCount: runs.length,
        successCount,
        successRate: runs.length > 0 ? Math.round((successCount / runs.length) * 100) : 0,
        p50Duration: computePercentile(durations, 0.5),
        p90Duration: computePercentile(durations, 0.9),
        debugInfo,
      };
    });
  }, [allWorkflows]);

  const sortedWorkflowSummaries = useMemo(() => {
    let sorted = [...workflowSummaries];
    if (filterName) {
      const query = filterName.toLowerCase();
      sorted = sorted.filter((s) => s.name.toLowerCase().includes(query));
    }
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (workflowSummarySortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'p90': cmp = a.p90Duration - b.p90Duration; break;
        case 'p50': cmp = a.p50Duration - b.p50Duration; break;
        case 'successRate': cmp = a.successRate - b.successRate; break;
        default: cmp = a.runCount - b.runCount; break;
      }
      return workflowSummarySortOrder === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [workflowSummaries, filterName, workflowSummarySortField, workflowSummarySortOrder]);

  const successRunLineData = useMemo(() => {
    if (!selectedWorkflowSummaryName) return [];
    const matchingRuns = allWorkflows.filter(
      (r) => r.name === selectedWorkflowSummaryName && r.conclusion === 'success'
    );
    return matchingRuns
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((run, idx) => ({
        index: idx,
        date: run.created_at,
        label: format(new Date(run.created_at), 'MMM dd HH:mm'),
        duration: run.durationInSeconds,
        runId: run.id,
        html_url: run.html_url,
      }));
  }, [allWorkflows, selectedWorkflowSummaryName]);

  const buildWorkflowFileUrl = (workflowName: string): string => {
    if (!selectedRepo) return '#';
    // Link to GitHub Actions page filtered by workflow name
    return `https://github.com/${selectedRepo.owner}/${selectedRepo.repo}/actions?query=workflow%3A%22${encodeURIComponent(workflowName)}%22`;
  };

  const toggleJobSort = (field: JobSortField) => {
    if (jobSortField === field) {
      setJobSortOrder(jobSortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setJobSortField(field);
      setJobSortOrder('desc');
    }
  };

  const toggleJobSummarySort = (field: JobSummarySortField) => {
    if (jobSummarySortField === field) {
      setJobSummarySortOrder(jobSummarySortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setJobSummarySortField(field);
      setJobSummarySortOrder(field === 'name' ? 'asc' : 'desc');
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

        <section className="rounded-xl border border-neutral-100 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-4 flex items-center gap-2">
            <TestTube className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
            <h2 className="text-lg font-bold">Test Case Statistics</h2>
          </div>
          {(() => {
            const stats = selectedRepo ? testCaseStatsByKey[selectedRepo.key] : null;
            if (!stats) {
              return (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  暂无测试用例统计数据
                </div>
              );
            }
            return (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
                  <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                    <TestTube className="h-4 w-4" />
                    <span>总测试用例数</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
                    {stats.total_test_cases}
                  </div>
                </div>
                <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
                  <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                    <Cpu className="h-4 w-4" />
                    <span>昇腾硬件用例数</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
                    {stats.ascend_test_cases}
                  </div>
                </div>
                <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
                  <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                    <Monitor className="h-4 w-4" />
                    <span>NVIDIA硬件用例数</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
                    {stats.nvidia_test_cases}
                  </div>
                </div>
              </div>
            );
          })()}
        </section>

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
                      <th className="px-6 py-3">
                        <span className="inline-flex items-center gap-1.5">PR E2E P90<MetricTooltip definition={METRIC_DEFINITIONS.prE2EP90Minutes} /></span>
                      </th>
                      <th className="px-6 py-3">
                        <span className="inline-flex items-center gap-1.5">CI E2E P90<MetricTooltip definition={METRIC_DEFINITIONS.ciE2EP90Minutes} /></span>
                      </th>
                      <th className="px-6 py-3">
                        <span className="inline-flex items-center gap-1.5">PR Review P90<MetricTooltip definition={METRIC_DEFINITIONS.reviewP90Minutes} /></span>
                      </th>
                      <th className="px-6 py-3">
                        <span className="inline-flex items-center gap-1.5">CI E2E SLA<MetricTooltip definition={METRIC_DEFINITIONS.ciE2ESlaRate} /></span>
                      </th>
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
                      <span className="inline-flex items-center gap-1.5">
                        {metric.label}
                        <MetricTooltip definition={METRIC_DEFINITIONS[metric.key]} />
                      </span>
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
                      <Legend
                        content={({ payload }) => {
                          if (!payload || payload.length === 0) return null;
                          return (
                            <div className="flex items-center justify-center gap-4 pt-2">
                              {payload.map((entry: LegendPayload, index: number) => {
                                const metricKey = entry.dataKey as MetricKey;
                                const definition = METRIC_DEFINITIONS[metricKey];
                                return (
                                  <span key={`item-${index}`} className="inline-flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                                    <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: entry.color }} />
                                    <span>{entry.value}</span>
                                    {definition && <MetricTooltip definition={definition} />}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        }}
                      />
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
              {/* Row 1: Title + Tabs + Filter */}
              <div className="flex flex-col gap-4 border-b border-neutral-100 p-6 dark:border-neutral-800 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-bold">CI Pipeline & PR Details</h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Drill into PR, workflow, and job details for {selectedRepo.key}.</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
                    {([['pr', 'PR'], ['event', 'Event'], ['workflow', 'Workflow'], ['job', 'Job']] as [PrLifecycleViewMode, string][]).map(([mode, label]) => (
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
                      placeholder={prLifecycleViewMode === 'pr' ? 'Filter by PR, title, branch...' : prLifecycleViewMode === 'event' ? 'Filter by event, workflow, branch...' : prLifecycleViewMode === 'workflow' ? 'Filter by workflow, branch...' : 'Filter by job, workflow...'}
                      value={filterName}
                      onChange={(event) => setFilterName(event.target.value)}
                      className="w-48 bg-transparent outline-none"
                    />
                  </div>
                </div>
              </div>
              {/* Row 2: Time Range Selector — fixed position, applies to all CI Pipeline tabs */}
              <div className="flex items-center gap-2 border-b border-neutral-100 px-6 py-2.5 dark:border-neutral-800">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Time Range:</span>
                {[7, 14, 30, 90].map((value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => { setWorkflowUseCustomRange(false); setWorkflowDays(value); }}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-all ${
                      workflowDays === value && !workflowUseCustomRange
                        ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                        : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950'
                    }`}
                  >
                    {value}d
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setWorkflowUseCustomRange(true);
                    if (!workflowStartDate && !workflowEndDate) {
                      setWorkflowStartDate(format(workflowDateRange.start, 'yyyy-MM-dd'));
                      setWorkflowEndDate(format(workflowDateRange.end, 'yyyy-MM-dd'));
                    }
                  }}
                  className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-all ${
                    workflowUseCustomRange
                      ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
                      : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950'
                  }`}
                >
                  <CalendarIcon className="h-3 w-3" />
                  Custom
                </button>
                {workflowUseCustomRange && (
                  <div className="flex items-center gap-1 rounded-md border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
                    <input type="date" value={workflowStartDate} max={workflowEndDate || undefined} onChange={(e) => setWorkflowStartDate(e.target.value)} className="bg-transparent px-1 py-0.5 text-xs text-neutral-700 outline-none dark:text-neutral-300" />
                    <span className="text-neutral-400">-</span>
                    <input type="date" value={workflowEndDate} min={workflowStartDate || undefined} onChange={(e) => setWorkflowEndDate(e.target.value)} className="bg-transparent px-1 py-0.5 text-xs text-neutral-700 outline-none dark:text-neutral-300" />
                  </div>
                )}
              </div>

              {prLifecycleStats && (
                <div className="border-b border-neutral-100 px-6 py-4 dark:border-neutral-800">
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">排队时间<MetricTooltip definition="从 PR 提交到 CI 开始执行的等待时间。统计当前时间周期内所有 PR 的平均值、P50、P90。" /></div>
                      {prLifecycleStats.queueStats ? (
                        <div className="mt-2 flex gap-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          <span>avg: {formatDurationMinutes(prLifecycleStats.queueStats.avg)}</span>
                          <span>p50: {formatDurationMinutes(prLifecycleStats.queueStats.p50)}</span>
                          <span>p90: {formatDurationMinutes(prLifecycleStats.queueStats.p90)}</span>
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">Insufficient data</div>
                      )}
                    </div>
                    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">执行时间<MetricTooltip definition="CI 从开始执行到完成的耗时。统计当前时间周期内所有 PR 的平均值、P50、P90。" /></div>
                      {prLifecycleStats.ciStats ? (
                        <div className="mt-2 flex gap-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          <span>avg: {formatDurationMinutes(prLifecycleStats.ciStats.avg)}</span>
                          <span>p50: {formatDurationMinutes(prLifecycleStats.ciStats.p50)}</span>
                          <span>p90: {formatDurationMinutes(prLifecycleStats.ciStats.p90)}</span>
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">Insufficient data</div>
                      )}
                    </div>
                    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">合入时间<MetricTooltip definition="从 CI 完成到 PR 被合入的等待时间。统计当前时间周期内所有 PR 的平均值、P50、P90。" /></div>
                      {prLifecycleStats.mergeStats ? (
                        <div className="mt-2 flex gap-3 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          <span>avg: {formatDurationMinutes(prLifecycleStats.mergeStats.avg)}</span>
                          <span>p50: {formatDurationMinutes(prLifecycleStats.mergeStats.p50)}</span>
                          <span>p90: {formatDurationMinutes(prLifecycleStats.mergeStats.p90)}</span>
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">Insufficient data</div>
                      )}
                    </div>
                    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">强行合入率<MetricTooltip definition="PR 合入时间早于 CI 完成时间的比例，表示跳过 CI 检查直接合入的情况。" /></div>
                      {prLifecycleStats.mergedPrCount > 0 ? (
                        <div className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                          {Math.round((prLifecycleStats.forceMergedCount / prLifecycleStats.mergedPrCount) * 100)}%
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">Insufficient data</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

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
                  <>
                    <div className="overflow-x-auto">
                    <table className="w-full min-w-[1100px] table-fixed text-left text-sm">
                       <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                         <tr>
                           <th className="w-[30%] px-6 py-3">PR / Branch</th>
                           <th className="w-[12%] px-6 py-3">Status</th>
                           <th className="w-[12%] px-6 py-3">
                             <span className="inline-flex items-center gap-1.5">PR提交时间<MetricTooltip definition="Pull Request 创建的时间点。" /></span>
                           </th>
                           <th className="w-[11%] px-6 py-3">
                             <span className="inline-flex items-center gap-1.5">CI排队时间<MetricTooltip definition="从 PR 提交到 CI 开始执行的等待时间。" /></span>
                           </th>
                           <th className="w-[11%] px-6 py-3">
                             <span className="inline-flex items-center gap-1.5">CI执行时间<MetricTooltip definition="CI 从开始执行到完成的耗时。" /></span>
                           </th>
                           <th className="w-[12%] px-6 py-3">
                             <span className="inline-flex items-center gap-1.5">合入时间<MetricTooltip definition="从 CI 完成到 PR 被合入的等待时间（CI完成 → 合入）。" /></span>
                           </th>
                           <th className="w-[12%] px-6 py-3">
                             <span className="inline-flex items-center gap-1.5">强行合入<MetricTooltip definition="PR 合入时间早于 CI 完成时间，表示跳过了 CI 检查直接合入。" /></span>
                           </th>
                         </tr>
                       </thead>
                      <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                         {paginatedPrs.map((pr) => {
                           const detail = detailsByNumber[pr.number];
                           const isForceMerged = pr.merged_at && pr.ci_completed_at && pr.merged_at < pr.ci_completed_at;

                          return (
                            <React.Fragment key={pr.number}>
                              <tr className="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950/50">
                                <td className="px-6 py-4">
                                  <div className="flex items-center gap-2">
                                    <a href={pr.html_url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline dark:text-blue-400" title="View PR on GitHub">
                                      PR #{pr.number}
                                    </a>
                                    <button
                                      type="button"
                                      disabled={loadingDetailNumber === pr.number}
                                      onClick={() => void loadDetail(pr.number)}
                                      className="inline-flex items-center justify-center rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                                      aria-label={loadingDetailNumber === pr.number ? 'Loading PR details' : expandedPrNumber === pr.number ? 'Collapse PR details' : 'Expand PR details'}
                                    >
                                      {loadingDetailNumber === pr.number ? (
                                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
                                      ) : expandedPrNumber === pr.number ? (
                                        <ChevronUp className="h-4 w-4" />
                                      ) : (
                                        <ChevronDown className="h-4 w-4" />
                                      )}
                                    </button>
                                  </div>
                                  <div className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400" title={pr.title}>{pr.title}</div>
                                  <div className="mt-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400" title={pr.branch}>{pr.branch}</div>
                                </td>
                                <td className="px-6 py-4"><StatusBadge conclusion={pr.conclusion} /></td>
                                <td className="px-6 py-4 text-neutral-500 dark:text-neutral-400">{format(new Date(pr.created_at), 'MMM dd, HH:mm')}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.timeToCiStartInSeconds)}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.ciDurationInSeconds)}</td>
                                <td className="px-6 py-4 font-mono text-neutral-600 dark:text-neutral-400">{formatDurationMinutes(pr.mergeLeadTimeInSeconds)}</td>
                                <td className="px-6 py-4">
                                  {pr.merged_at ? (
                                    isForceMerged ? (
                                      <span className="inline-flex items-center gap-1 rounded-full border border-green-200/50 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-800/50 dark:bg-green-900/30 dark:text-green-400">
                                        ✓
                                      </span>
                                    ) : (
                                      <span className="text-neutral-400 dark:text-neutral-500">—</span>
                                    )
                                  ) : (
                                    <span className="text-neutral-400 dark:text-neutral-500">—</span>
                                  )}
                                </td>

                              </tr>

                              {expandedPrNumber === pr.number && detail && (
                                <tr>
                                  <td colSpan={7} className="p-4">
                                    <PrLifecycleTree data={detail} showPrRoot={false} />
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                       </tbody>
                     </table>
                   </div>
                    {filteredPrs.length > 10 && (
                      <div className="flex items-center justify-between gap-4 border-t border-neutral-100 px-6 py-4 dark:border-neutral-800">
                        <span className="text-sm text-neutral-500 dark:text-neutral-400">
                          Showing {(prPage - 1) * prPageSize + 1}–{Math.min(prPage * prPageSize, filteredPrs.length)} of {filteredPrs.length}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setPrPage((p) => Math.max(1, p - 1))}
                            disabled={prPage === 1}
                            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950"
                          >
                            Previous
                          </button>
                          <select
                            value={prPageSize}
                            onChange={(e) => { setPrPageSize(Number(e.target.value) as 10 | 50 | 200); setPrPage(1); }}
                            className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-700 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                          >
                            <option value={10}>10 / page</option>
                            <option value={50}>50 / page</option>
                            <option value={200}>200 / page</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => setPrPage((p) => p + 1)}
                            disabled={prPage * prPageSize >= filteredPrs.length}
                            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-950"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )
                ) : prLifecycleViewMode === 'event' ? (
                /* ===== EVENT VIEW ===== */
                <div>
                  {allWorkflowsError ? (
                    <div className="p-8 text-center text-sm text-red-500 dark:text-red-400">Failed to load workflow runs. Please try again later.</div>
                  ) : allWorkflowsLoading ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading workflow runs...</div>
                  ) : allWorkflows.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No workflow runs found for the selected date range.</div>
                  ) : (
                    <EventsTreeView allWorkflows={allWorkflows} filterName={filterName} />
                  )}
                </div>
               ) : prLifecycleViewMode === 'workflow' ? (
                /* ===== WORKFLOW SUMMARY VIEW ===== */
                <div>
                  {allWorkflowsError ? (
                    <div className="p-8 text-center text-sm text-red-500 dark:text-red-400">Failed to load workflows. Please try again later.</div>
                  ) : allWorkflowsLoading ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading workflows...</div>
                  ) : workflowSummaries.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No workflows found for the selected date range.</div>
                  ) : (
                    <>
                      {/* Workflow Summary Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                            <tr>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleWorkflowSummarySort('name')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkflowSummarySort('name'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">Workflow {workflowSummarySortField === 'name' ? (workflowSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th className="px-6 py-3 text-center">Runs</th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleWorkflowSummarySort('p90')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkflowSummarySort('p90'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">P90 耗时 {workflowSummarySortField === 'p90' ? (workflowSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleWorkflowSummarySort('p50')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkflowSummarySort('p50'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">P50 耗时 {workflowSummarySortField === 'p50' ? (workflowSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleWorkflowSummarySort('successRate')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkflowSummarySort('successRate'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">成功率 {workflowSummarySortField === 'successRate' ? (workflowSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                            {sortedWorkflowSummaries.map((summary) => {
                              const isExpanded = selectedWorkflowSummaryName === summary.name;

                              return (
                                <React.Fragment key={summary.name}>
                                  <tr
                                    onClick={() => setSelectedWorkflowSummaryName(isExpanded ? null : summary.name)}
                                    className={`cursor-pointer transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950/50 ${
                                      isExpanded ? 'bg-blue-50/60 dark:bg-blue-900/10' : ''
                                    }`}
                                  >
                                    <td className="px-6 py-4">
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); setSelectedWorkflowSummaryName(isExpanded ? null : summary.name); }}
                                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSelectedWorkflowSummaryName(isExpanded ? null : summary.name); } }}
                                          tabIndex={0}
                                          aria-expanded={isExpanded}
                                          aria-label={isExpanded ? 'Collapse workflow details' : 'Expand workflow details'}
                                          className="flex w-4 shrink-0 cursor-pointer items-center justify-center rounded text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-neutral-200 dark:hover:bg-neutral-800"
                                        >
                                          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                        </button>
                                        <span className={`h-2 w-2 rounded-full ${isExpanded ? 'bg-blue-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
                                        <a
                                          href={buildWorkflowFileUrl(summary.name)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
                                          onClick={(e) => e.stopPropagation()}
                                          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                                          title="View workflow runs"
                                        >
                                          {summary.name}
                                        </a>
                                        <ExternalLink className="h-3 w-3 text-neutral-400" />
                                      </div>
                                    </td>
                                    <td className="px-6 py-4 text-center font-mono text-neutral-600 dark:text-neutral-400">{summary.runCount}</td>
                                    <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatDurationMinutes(summary.p90Duration)}</td>
                                    <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatDurationMinutes(summary.p50Duration)}</td>
                                    <td className="px-6 py-4">
                                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                                        summary.successRate >= 90 ? 'border border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400' :
                                        summary.successRate >= 70 ? 'border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                                        'border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400'
                                      }`}>
                                        {summary.successRate}%
                                      </span>
                                    </td>
                                  </tr>
                                  {isExpanded && (
                                    <tr>
                                      <td colSpan={5} className="p-0">
                                        <WorkflowLineChartView summary={summary} lineData={successRunLineData} />
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
               ) : (
                /* ===== JOB VIEW ===== */
                <div>
                  {selectedJobName ? (
                    <JobDetailView
                      jobName={selectedJobName}
                      allWorkflows={allWorkflows}
                      dateRange={workflowDateRange}
                      onBack={() => setSelectedJobName(null)}
                    />
                  ) : allWorkflowsError ? (
                    <div className="p-8 text-center text-sm text-red-500 dark:text-red-400">Failed to load jobs. Please try again later.</div>
                  ) : allWorkflowsLoading ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Loading jobs...</div>
                  ) : sortedJobSummaries.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">No jobs found for the selected date range.</div>
                  ) : (
                    <>
                      {/* Job Summary Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 font-medium text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
                            <tr>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleJobSummarySort('name')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJobSummarySort('name'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">Job Name {jobSummarySortField === 'name' ? (jobSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th className="px-6 py-3 text-center">Runs</th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleJobSummarySort('p90Queue')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJobSummarySort('p90Queue'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">P90 Queue {jobSummarySortField === 'p90Queue' ? (jobSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleJobSummarySort('p90E2e')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJobSummarySort('p90E2e'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">P90 E2E {jobSummarySortField === 'p90E2e' ? (jobSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleJobSummarySort('p50E2e')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJobSummarySort('p50E2e'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">P50 E2E {jobSummarySortField === 'p50E2e' ? (jobSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                              <th
                                className="cursor-pointer px-6 py-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                onClick={() => toggleJobSummarySort('successRate')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleJobSummarySort('successRate'); } }}
                                tabIndex={0}
                                role="button"
                              >
                                <span className="inline-flex items-center gap-1">Success Rate {jobSummarySortField === 'successRate' ? (jobSummarySortOrder === 'asc' ? '↑' : '↓') : ''}</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                            {sortedJobSummaries.map((summary) => {
                              const isExpanded = selectedJobSummaryName === summary.name;

                              return (
                                <React.Fragment key={summary.name}>
                                  <tr
                                    onClick={() => setSelectedJobSummaryName(isExpanded ? null : summary.name)}
                                    className={`cursor-pointer transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-950/50 ${
                                      isExpanded ? 'bg-blue-50/60 dark:bg-blue-900/10' : ''
                                    }`}
                                  >
                                    <td className="px-6 py-4">
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); setSelectedJobSummaryName(isExpanded ? null : summary.name); }}
                                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSelectedJobSummaryName(isExpanded ? null : summary.name); } }}
                                          tabIndex={0}
                                          aria-expanded={isExpanded}
                                          aria-label={isExpanded ? 'Collapse job details' : 'Expand job details'}
                                          className="flex w-4 shrink-0 cursor-pointer items-center justify-center rounded text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-neutral-200 dark:hover:bg-neutral-800"
                                        >
                                          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                        </button>
                                        <span className={`h-2 w-2 rounded-full ${isExpanded ? 'bg-blue-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); setSelectedJobName(summary.name); }}
                                          className="font-medium text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
                                          title="View job detail"
                                        >
                                          {summary.name}
                                        </button>
                                      </div>
                                    </td>
                                    <td className="px-6 py-4 text-center font-mono text-neutral-600 dark:text-neutral-400">{summary.runCount}</td>
                                    <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatDurationMinutes(summary.p90Queue)}</td>
                                    <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatDurationMinutes(summary.p90E2e)}</td>
                                    <td className="px-6 py-4 font-mono text-neutral-700 dark:text-neutral-300">{formatDurationMinutes(summary.p50E2e)}</td>
                                    <td className="px-6 py-4">
                                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                                        summary.successRate >= 90 ? 'border border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400' :
                                        summary.successRate >= 70 ? 'border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                                        'border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400'
                                      }`}>
                                        {summary.successRate}%
                                      </span>
                                    </td>
                                  </tr>
                                  {isExpanded && (
                                    <tr>
                                      <td colSpan={6} className="p-0">
                                        <JobLineChartView summary={summary} lineData={jobSuccessRunLineData} />
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
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
