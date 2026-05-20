import { describe, expect, it, vi } from 'vitest';

describe('pr-data-fetcher', () => {
  it('throws when Supabase env vars are missing', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchPullRequestIndex } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestIndex('foo', 'bar')).rejects.toThrow('Missing SUPABASE_URL');

    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it('throws when Supabase env vars are missing for detail fetch', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    vi.resetModules();
    const { fetchPullRequestDetail } = await import('./pr-data-fetcher');

    await expect(fetchPullRequestDetail('foo', 'bar', 42)).rejects.toThrow('Missing SUPABASE_URL');

    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
});
