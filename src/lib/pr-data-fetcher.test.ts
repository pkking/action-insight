import { describe, expect, it, vi } from 'vitest';

describe('pr-data-fetcher', () => {
  it('throws when Turso env vars are missing', async () => {
    const originalUrl = process.env.TURSO_URL;
    const originalKey = process.env.TURSO_SERVICE_ROLE_KEY;
    delete process.env.TURSO_URL;
    delete process.env.TURSO_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchPullRequestIndex } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestIndex('foo', 'bar')).rejects.toThrow('Database connection not configured');

    process.env.TURSO_URL = originalUrl;
    process.env.TURSO_SERVICE_ROLE_KEY = originalKey;
  });

  it('throws when Turso env vars are missing for detail fetch', async () => {
    const originalUrl = process.env.TURSO_URL;
    const originalKey = process.env.TURSO_SERVICE_ROLE_KEY;
    delete process.env.TURSO_URL;
    delete process.env.TURSO_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchPullRequestDetail } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestDetail('foo', 'bar', 42)).rejects.toThrow('Database connection not configured');

    process.env.TURSO_URL = originalUrl;
    process.env.TURSO_SERVICE_ROLE_KEY = originalKey;
  });
});
