import { describe, expect, it, vi } from 'vitest';

describe('fetchRuns', () => {
  it('throws when DB env vars are missing', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;

    vi.resetModules();
    const { fetchRuns } = await import('./data-fetcher');

    await expect(fetchRuns('foo', 'bar')).rejects.toThrow('Database connection not configured');

    process.env.PG_DATABASE_URL = originalUrl;
  });
});

describe('fetchLatestRuns', () => {
  it('throws when DB env vars are missing', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;

    vi.resetModules();
    const { fetchLatestRuns } = await import('./data-fetcher');

    await expect(fetchLatestRuns('foo', 'bar')).rejects.toThrow('Database connection not configured');

    process.env.PG_DATABASE_URL = originalUrl;
  });
});
