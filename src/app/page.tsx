import DashboardClient from './DashboardClient';
import { getHomepageData } from '@/lib/server-homepage-data';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

type DashboardPageProps = {
  searchParams?: Promise<SearchParams> | SearchParams;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const { repoOptions, repoIndexesByKey, testCaseStatsByKey, failedRepoKeys } = await getHomepageData();

  return (
    <DashboardClient
      initialFailedRepoKeys={failedRepoKeys}
      initialRepoIndexesByKey={repoIndexesByKey}
      initialRepoOptions={repoOptions}
      initialTestCaseStatsByKey={testCaseStatsByKey}
      initialSearchParams={resolvedSearchParams}
    />
  );
}
