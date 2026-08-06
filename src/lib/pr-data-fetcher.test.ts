import { describe, expect, it, vi } from 'vitest';

describe('pr-data-fetcher', () => {
  it('throws when DB env vars are missing', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestIndex } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestIndex('foo', 'bar')).rejects.toThrow('Database connection not configured');

    process.env.PG_DATABASE_URL = originalUrl;
  });

  it('throws when DB env vars are missing for detail fetch', async () => {
    const originalUrl = process.env.PG_DATABASE_URL;
    delete process.env.PG_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;

    vi.resetModules();
    const { fetchPullRequestDetail } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestDetail('foo', 'bar', 42)).rejects.toThrow('Database connection not configured');

    process.env.PG_DATABASE_URL = originalUrl;
  });
});
