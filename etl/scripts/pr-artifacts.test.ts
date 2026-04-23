import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { rebuildPullRequestArtifacts } from './pr-artifacts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('rebuildPullRequestArtifacts', () => {
  it('can be imported through tsx like the scheduled collector', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        "import('./etl/scripts/pr-artifacts.ts').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })",
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('writes a PR index and per-PR detail files from retained runs', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-insight-pr-artifacts-'));
    tempDirs.push(repoDir);

    await rebuildPullRequestArtifacts({
      octokit: {
        request: async (route: string) => {
          if (route === 'GET /rate_limit') {
            return {
              data: {
                resources: {
                  core: {
                    remaining: 100,
                  },
                },
              },
            };
          }

          return {
            data: {
              number: 42,
              title: 'Add PR lifecycle dashboard',
              state: 'closed',
              created_at: '2026-04-18T01:00:00Z',
              merged_at: '2026-04-18T02:15:00Z',
              html_url: 'https://github.com/acme/widgets/pull/42',
              user: { login: 'octocat' },
            },
          };
        },
      },
      owner: 'acme',
      repo: 'widgets',
      repoKey: 'acme/widgets',
      repoDir,
      files: ['2026-04-18.json'],
      storage: {
        readDayData: () => ({
          runs: [
            {
              id: 101,
              name: 'lint',
              head_branch: 'feature/pr-metrics',
              status: 'completed',
              conclusion: 'success',
              event: 'pull_request',
              created_at: '2026-04-18T01:05:00Z',
              updated_at: '2026-04-18T01:15:00Z',
              html_url: 'https://github.com/acme/widgets/actions/runs/101',
              durationInSeconds: 600,
              pull_requests: [{ number: 42 }],
              jobs: [],
            },
          ],
        }),
      },
    });

    const index = JSON.parse(fs.readFileSync(path.join(repoDir, 'prs', 'index.json'), 'utf8'));
    const detail = JSON.parse(fs.readFileSync(path.join(repoDir, 'prs', '42.json'), 'utf8'));

    expect(index.prs).toHaveLength(1);
    expect(index.prs[0]).toMatchObject({ number: 42, title: 'Add PR lifecycle dashboard' });
    expect(detail.pr).toMatchObject({ number: 42, workflows: [expect.objectContaining({ id: 101 })] });
  });

  it('recovers PR associations from head_sha when workflow runs have no pull_requests refs', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-insight-pr-artifacts-'));
    tempDirs.push(repoDir);

    const request = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET /rate_limit') {
        return Promise.resolve({
          data: {
            resources: {
              core: {
                remaining: 100,
              },
            },
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls') {
        return Promise.resolve({
          data: [
            {
              number: 42,
            },
          ],
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return Promise.resolve({
          data: {
            number: 42,
            title: 'Add PR lifecycle dashboard',
            state: 'closed',
            created_at: '2026-04-18T01:00:00Z',
            merged_at: '2026-04-18T02:15:00Z',
            html_url: 'https://github.com/acme/widgets/pull/42',
            user: { login: 'octocat' },
          },
        });
      }

      throw new Error(`Unexpected route: ${route}`);
    });

    await rebuildPullRequestArtifacts({
      octokit: { request },
      owner: 'acme',
      repo: 'widgets',
      repoKey: 'acme/widgets',
      repoDir,
      files: ['2026-04-18.json'],
      storage: {
        readDayData: () => ({
          runs: [
            {
              id: 101,
              name: 'lint',
              head_branch: 'feature/pr-metrics',
              head_sha: 'abc123',
              status: 'completed',
              conclusion: 'success',
              event: 'pull_request',
              created_at: '2026-04-18T01:05:00Z',
              updated_at: '2026-04-18T01:15:00Z',
              html_url: 'https://github.com/acme/widgets/actions/runs/101',
              durationInSeconds: 600,
              pull_requests: [],
              jobs: [],
            },
          ],
        }),
      },
    });

    const index = JSON.parse(fs.readFileSync(path.join(repoDir, 'prs', 'index.json'), 'utf8'));

    expect(index.prs).toHaveLength(1);
    expect(index.prs[0]).toMatchObject({ number: 42, title: 'Add PR lifecycle dashboard' });
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      expect.objectContaining({ owner: 'acme', repo: 'widgets', commit_sha: 'abc123' })
    );
  });

  it('still writes partial artifacts when SHA resolution exceeds the rate-limit budget', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-insight-pr-artifacts-'));
    tempDirs.push(repoDir);

    const request = vi.fn().mockImplementation((route: string) => {
      if (route === 'GET /rate_limit') {
        return Promise.resolve({
          data: {
            resources: {
              core: {
                remaining: 1,
              },
            },
          },
        });
      }

      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return Promise.resolve({
          data: {
            number: 42,
            title: 'Existing PR association',
            state: 'closed',
            created_at: '2026-04-18T01:00:00Z',
            merged_at: '2026-04-18T02:15:00Z',
            html_url: 'https://github.com/acme/widgets/pull/42',
            user: { login: 'octocat' },
          },
        });
      }

      throw new Error(`Unexpected route: ${route}`);
    });

    await rebuildPullRequestArtifacts({
      octokit: { request },
      owner: 'acme',
      repo: 'widgets',
      repoKey: 'acme/widgets',
      repoDir,
      files: ['2026-04-18.json'],
      storage: {
        readDayData: () => ({
          runs: [
            {
              id: 101,
              name: 'lint',
              head_branch: 'feature/pr-metrics',
              status: 'completed',
              conclusion: 'success',
              event: 'pull_request',
              created_at: '2026-04-18T01:05:00Z',
              updated_at: '2026-04-18T01:15:00Z',
              html_url: 'https://github.com/acme/widgets/actions/runs/101',
              durationInSeconds: 600,
              pull_requests: [{ number: 42 }],
              jobs: [],
            },
            {
              id: 102,
              name: 'test',
              head_branch: 'feature/new-pr',
              head_sha: 'abc123',
              status: 'completed',
              conclusion: 'success',
              event: 'pull_request',
              created_at: '2026-04-18T01:10:00Z',
              updated_at: '2026-04-18T01:20:00Z',
              html_url: 'https://github.com/acme/widgets/actions/runs/102',
              durationInSeconds: 600,
              pull_requests: [],
              jobs: [],
            },
          ],
        }),
      },
    });

    const index = JSON.parse(fs.readFileSync(path.join(repoDir, 'prs', 'index.json'), 'utf8'));

    expect(index.prs).toHaveLength(1);
    expect(index.prs[0]).toMatchObject({ number: 42, title: 'Existing PR association' });
    expect(index).toMatchObject({
      partialPrResolution: true,
      resolvedPrShaCount: 0,
      unresolvedPrShaCount: 1,
      skippedPrShaCount: 1,
    });
    expect(request).not.toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      expect.anything()
    );
  });
});
