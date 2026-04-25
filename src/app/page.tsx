import DashboardClient from './DashboardClient';
import { getHomepageData } from '@/lib/server-homepage-data';

type SearchParams = Record<string, string | string[] | undefined>;

type DashboardPageProps = {
  searchParams?: Promise<SearchParams> | SearchParams;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const { repoOptions, repoIndexesByKey, failedRepoKeys } = await getHomepageData();

  return (
    <DashboardClient
      initialFailedRepoKeys={failedRepoKeys}
      initialRepoIndexesByKey={repoIndexesByKey}
      initialRepoOptions={repoOptions}
      initialSearchParams={resolvedSearchParams}
    />
  );
}
