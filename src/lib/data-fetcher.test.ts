import { describe, expect, it, vi } from 'vitest';

describe('fetchRuns', () => {
  it('throws when Supabase env vars are missing', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchRuns } = await import('./data-fetcher');

    await expect(fetchRuns('foo', 'bar')).rejects.toThrow('Missing SUPABASE_URL');

    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
});

describe('fetchLatestRuns', () => {
  it('throws when Supabase env vars are missing', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchLatestRuns } = await import('./data-fetcher');

    await expect(fetchLatestRuns('foo', 'bar')).rejects.toThrow('Missing SUPABASE_URL');

    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
});
