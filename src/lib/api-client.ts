type FetchRunsParams = { owner: string; repo: string; startDate: string; endDate: string; includeSteps?: boolean };
type FetchLatestRunsParams = { owner: string; repo: string; maxFiles?: number };
type FetchPullRequestDetailParams = { owner: string; repo: string; number: number };
type FetchWorkflowAttemptsParams = {
  owner: string;
  repo: string;
  workflowFile: string;
  workflowRef?: string | null;
  resourceModel?: string | null;
};

export async function callApi<T>(action: 'fetchRuns', params: FetchRunsParams, signal?: AbortSignal): Promise<T>;
export async function callApi<T>(action: 'fetchLatestRuns', params: FetchLatestRunsParams, signal?: AbortSignal): Promise<T>;
export async function callApi<T>(action: 'fetchPullRequestDetail', params: FetchPullRequestDetailParams, signal?: AbortSignal): Promise<T>;
export async function callApi<T>(action: 'fetchWorkflowAttempts', params: FetchWorkflowAttemptsParams, signal?: AbortSignal): Promise<T>;
export async function callApi<T>(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
    signal,
  });

  const result = await response.json().catch(() => ({ error: `Invalid response from server (status ${response.status})` }));

  if (!response.ok) {
    throw new Error(result.error || `API request failed with status ${response.status}`);
  }

  if (!('data' in result)) {
    throw new Error(result.error || `Invalid response from server: missing data field (status ${response.status})`);
  }

  return result.data;
}
