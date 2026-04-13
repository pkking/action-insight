export interface CollectCliOptions {
  forceFullBackfill: boolean;
  repoName?: string;
}

export function parseCollectCliOptions(argv: string[]): CollectCliOptions {
  let repoName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--repo' || arg === '-r') && argv[index + 1]) {
      repoName = argv[index + 1];
      index += 1;
    }
  }

  return {
    forceFullBackfill: argv.includes('--force-full-backfill') || argv.includes('--full'),
    repoName,
  };
}

export function resolveTargetRepos(configuredRepos: string[], repoName?: string): string[] {
  if (repoName) {
    return [repoName];
  }

  return configuredRepos;
}
