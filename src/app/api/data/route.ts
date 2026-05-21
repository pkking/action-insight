import { NextResponse } from 'next/server';
import { fetchRuns, fetchLatestRuns } from '@/lib/data-fetcher';
import { fetchPullRequestDetail } from '@/lib/pr-data-fetcher';
import { getTrackedRepoOptions } from '@/lib/server-homepage-data';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILES_LIMIT = 100;

type FetchRunsRequest = {
  action: 'fetchRuns';
  owner: string;
  repo: string;
  startDate: string;
  endDate: string;
};

type FetchLatestRunsRequest = {
  action: 'fetchLatestRuns';
  owner: string;
  repo: string;
  maxFiles?: number;
};

type FetchPullRequestDetailRequest = {
  action: 'fetchPullRequestDetail';
  owner: string;
  repo: string;
  number: number;
};

type DataRequest =
  | FetchRunsRequest
  | FetchLatestRunsRequest
  | FetchPullRequestDetailRequest;

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  // Same-origin fetch() typically doesn't send Origin header.
  // Cross-origin requests always do — validate when present.
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    return !!(host && originHost === host);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null) as DataRequest | null;

    if (!body) {
      return NextResponse.json({ error: 'Invalid or missing JSON body' }, { status: 400 });
    }

    if (!body.action || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'Missing required field: action' }, { status: 400 });
    }

    if (!body.owner || typeof body.owner !== 'string') {
      return NextResponse.json({ error: 'Missing required field: owner' }, { status: 400 });
    }

    if (!body.repo || typeof body.repo !== 'string') {
      return NextResponse.json({ error: 'Missing required field: repo' }, { status: 400 });
    }

    const repos = await getTrackedRepoOptions();
    const repoKey = `${body.owner}/${body.repo}`;
    if (!repos.some((r) => r.key === repoKey)) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    switch (body.action) {
      case 'fetchRuns': {
        if (!body.startDate || !body.endDate) {
          return NextResponse.json({ error: 'Missing required fields: startDate, endDate' }, { status: 400 });
        }
        if (!DATE_REGEX.test(body.startDate) || !DATE_REGEX.test(body.endDate)) {
          return NextResponse.json({ error: 'Invalid date format: use YYYY-MM-DD' }, { status: 400 });
        }
        const runs = await fetchRuns(body.owner, body.repo, {
          startDate: body.startDate,
          endDate: body.endDate,
        });
        return NextResponse.json({ data: runs });
      }

      case 'fetchLatestRuns': {
        if (body.maxFiles !== undefined && typeof body.maxFiles !== 'number') {
          return NextResponse.json({ error: 'Invalid field: maxFiles must be a number' }, { status: 400 });
        }
        const maxFiles = body.maxFiles !== undefined ? Math.min(body.maxFiles, MAX_FILES_LIMIT) : undefined;
        const runs = await fetchLatestRuns(body.owner, body.repo, maxFiles);
        return NextResponse.json({ data: runs });
      }

      case 'fetchPullRequestDetail': {
        if (typeof body.number !== 'number') {
          return NextResponse.json({ error: 'Missing required field: number' }, { status: 400 });
        }
        const detail = await fetchPullRequestDetail(body.owner, body.repo, body.number);
        return NextResponse.json({ data: detail });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error('API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
