import { NextResponse } from 'next/server';
import { getTursoClient } from '@/lib/turso';
import { getTrackedRepoOptions } from '@/lib/server-homepage-data';

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
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
    const body = await request.json().catch(() => null) as {
      action?: string;
      owner?: string;
      repo?: string;
      days?: number;
    } | null;

    if (!body) {
      return NextResponse.json({ error: 'Invalid or missing JSON body' }, { status: 400 });
    }

    if (body.action !== 'fetchTestCaseStats') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
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

    const client = getTursoClient();

    const { rows: repoRows } = await client.execute({
      sql: `SELECT id FROM repos WHERE owner = ? AND repo = ?`,
      args: [body.owner, body.repo],
    });

    if (repoRows.length === 0) {
      return NextResponse.json({ data: null });
    }

    const repoId = repoRows[0].id;

    const { rows: statsRows } = await client.execute({
      sql: `SELECT * FROM test_case_stats WHERE repo_id = ? ORDER BY generated_at DESC LIMIT 1`,
      args: [repoId],
    });

    if (statsRows.length === 0) {
      return NextResponse.json({ data: null });
    }

    const statsData = statsRows[0];
    return NextResponse.json({
      data: {
        total_test_cases: statsData.total_test_cases as number,
        ascend_test_cases: statsData.ascend_test_cases as number,
        nvidia_test_cases: statsData.nvidia_test_cases as number,
        window_start: statsData.window_start as string,
        window_end: statsData.window_end as string,
        generated_at: statsData.generated_at as string,
      },
    });
  } catch (err) {
    console.error('Test case stats API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
