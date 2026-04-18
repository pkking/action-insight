export interface CollectCliOptions {
  forceFullBackfill: boolean;
  reverse: boolean;
  repoName?: string;
}

export function parseCollectCliOptions(argv: string[]): CollectCliOptions {
  let repoName: string | undefined;
  let forceFullBackfill = false;
  let reverse = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if ((arg === '--repo' || arg === '-r') && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      repoName = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--force-full-backfill' || arg === '--full') {
      forceFullBackfill = true;
    }

    if (arg === '--reverse') {
      reverse = true;
    }
  }

  return { forceFullBackfill, reverse, repoName };
}

export function resolveTargetRepos(configuredRepos: string[], repoName?: string): string[] {
  if (repoName) {
    return [repoName];
  }

  return configuredRepos;
}
