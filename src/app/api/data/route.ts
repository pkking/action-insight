import { NextResponse } from 'next/server';
import { fetchRuns, fetchLatestRuns } from '@/lib/data-fetcher';
import { fetchPullRequestDetail } from '@/lib/pr-data-fetcher';

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

export async function POST(request: Request) {
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

    switch (body.action) {
      case 'fetchRuns': {
        if (!body.startDate || !body.endDate) {
          return NextResponse.json({ error: 'Missing required fields: startDate, endDate' }, { status: 400 });
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
        const runs = await fetchLatestRuns(body.owner, body.repo, body.maxFiles);
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
