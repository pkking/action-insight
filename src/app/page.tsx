import DashboardShell from './DashboardShell';
import { getDashboardReadModel, parsePrDashboardQuery } from '@/lib/dashboard-read-model';
import { getTrackedRepoOptions } from '@/lib/server-homepage-data';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

type DashboardPageProps = {
  searchParams?: Promise<SearchParams> | SearchParams;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const urlParams = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(resolvedSearchParams)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) urlParams.append(key, value);
    } else if (rawValue !== undefined) {
      urlParams.set(key, rawValue);
    }
  }

  const query = parsePrDashboardQuery(urlParams);
  const [repoOptions, result] = await Promise.all([
    getTrackedRepoOptions(),
    getDashboardReadModel(query),
  ]);

  return (
    <DashboardShell
      repoOptions={repoOptions}
      result={result}
      searchParams={resolvedSearchParams}
    />
  );
}
