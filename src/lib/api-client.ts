export async function callApi<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
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
