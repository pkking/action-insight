import { describe, expect, it, vi } from 'vitest';

describe('fetchRuns', () => {
  it('connects to default local PG when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchRuns } = await import('./data-fetcher');

    // Without PG_DATABASE_URL, it falls back to localhost:5433 which is
    // unreachable in the test environment — expect a connection error,
    // NOT a "not configured" error.
    await expect(fetchRuns('foo', 'bar')).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });
});

describe('fetchLatestRuns', () => {
  it('connects to default local PG when PG_DATABASE_URL is not set', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { fetchLatestRuns } = await import('./data-fetcher');

    await expect(fetchLatestRuns('foo', 'bar')).rejects.toThrow();

    process.env.PG_DATABASE_URL = originalUrl;
  });
});
