import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/lib/supabase';
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

    const supabase = getSupabaseClient();

    const { data: repoData } = await supabase
      .from('repos')
      .select('id')
      .eq('owner', body.owner)
      .eq('repo', body.repo)
      .single();

    if (!repoData?.id) {
      return NextResponse.json({ data: null });
    }

    const { data: statsData } = await supabase
      .from('test_case_stats')
      .select('*')
      .eq('repo_id', repoData.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .single();

    if (!statsData) {
      return NextResponse.json({ data: null });
    }

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
