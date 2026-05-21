import { NextResponse } from 'next/server';
import { fetchIndex, fetchRunsFromIndex, fetchLatestRunsFromIndex } from '@/lib/data-fetcher';
import { fetchPullRequestDetail } from '@/lib/pr-data-fetcher';

type FetchIndexRequest = {
  action: 'fetchIndex';
  owner: string;
  repo: string;
};

type FetchRunsFromIndexRequest = {
  action: 'fetchRunsFromIndex';
  owner: string;
  repo: string;
  startDate: string;
  endDate: string;
};

type FetchLatestRunsFromIndexRequest = {
  action: 'fetchLatestRunsFromIndex';
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
  | FetchIndexRequest
  | FetchRunsFromIndexRequest
  | FetchLatestRunsFromIndexRequest
  | FetchPullRequestDetailRequest;

export async function POST(request: Request) {
  const body: DataRequest = await request.json();

  try {
    switch (body.action) {
      case 'fetchIndex': {
        const index = await fetchIndex(body.owner, body.repo);
        return NextResponse.json({ data: index });
      }

      case 'fetchRunsFromIndex': {
        const repoIndex = await fetchIndex(body.owner, body.repo);
        const runs = await fetchRunsFromIndex(body.owner, body.repo, repoIndex, {
          startDate: body.startDate,
          endDate: body.endDate,
        });
        return NextResponse.json({ data: runs });
      }

      case 'fetchLatestRunsFromIndex': {
        const repoIndex = await fetchIndex(body.owner, body.repo);
        const runs = await fetchLatestRunsFromIndex(body.owner, body.repo, repoIndex, body.maxFiles);
        return NextResponse.json({ data: runs });
      }

      case 'fetchPullRequestDetail': {
        const detail = await fetchPullRequestDetail(body.owner, body.repo, body.number);
        return NextResponse.json({ data: detail });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
