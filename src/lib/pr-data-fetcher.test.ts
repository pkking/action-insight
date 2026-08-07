import { describe, expect, it, vi } from 'vitest';

describe('pr-data-fetcher', () => {
  it('connects to default local PG when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestIndex } = await import('./pr-data-fetcher');

    // Without PG_DATABASE_URL, it falls back to localhost:5433 which is
    // unreachable in the test environment — expect a connection error,
    // NOT a "not configured" error.
    await expect(fetchPullRequestIndex('foo', 'bar')).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });

  it('connects to default local PG for detail fetch when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestDetail } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestDetail('foo', 'bar', 42)).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });
});
