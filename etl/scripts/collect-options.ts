export interface CollectCliOptions {
  forceFullBackfill: boolean;
  reverse: boolean;
  forward: boolean;
  skipJobs: boolean;
  repoName?: string;
  help: boolean;
}

export const CLI_HELP = `
Usage: npx tsx etl/scripts/collect.ts [options]

Collect GitHub Actions CI/CD data for configured repositories.

Options:
  -r, --repo <owner/repo>       Collect data for a specific repository only
                                Overrides the repos.yaml configuration
  --force-full-backfill, --full Restart history backfill from the earliest retained day
                                Rebuilds the full retention window (default: 90 days)
  --reverse                     Collect from today backward instead of oldest-first
                                This is the DEFAULT behavior
  --forward                     Collect from oldest to today (legacy behavior)
                                Useful for rebuilding history in chronological order
  --skip-jobs, --workflow-only   Collect workflow attempts without fetching jobs
  -h, --help                    Show this help message

Environment Variables:
  GITHUB_TOKEN                  GitHub personal access token (required)
  RETENTION_DAYS                Number of days to retain data (default: 90)
  TARGET_REPOS                  Comma-separated list of repos (fallback if repos.yaml missing)
  VERBOSE                       Enable verbose logging (true or 1)

Examples:
  # Collect all configured repos (recent data first)
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts

  # Collect a specific repo
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo tile-ai/tilelang-ascend

  # Force full backfill for a repo
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo tile-ai/tilelang-ascend --force-full-backfill

  # Collect recent data first (reverse order; explicit)
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo tile-ai/tilelang-ascend --reverse

  # Collect oldest-first
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo tile-ai/tilelang-ascend --forward

  # Collect workflow attempts only; jobs can be backfilled in a later pass
  GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo tile-ai/tilelang-ascend --workflow-only

  # Show help
  npx tsx etl/scripts/collect.ts --help
`.trim();

export function parseCollectCliOptions(argv: string[]): CollectCliOptions {
  let repoName: string | undefined;
  let forceFullBackfill = false;
  let reverse = true;
  let forward = false;
  let skipJobs = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

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
      forward = false;
    }

    if (arg === '--forward') {
      reverse = false;
      forward = true;
    }

    if (arg === '--skip-jobs' || arg === '--workflow-only') {
      skipJobs = true;
    }
  }

  return { forceFullBackfill, reverse, forward, skipJobs, repoName, help };
}

export function resolveTargetRepos(configuredRepos: string[], repoName?: string): string[] {
  if (repoName) {
    return [repoName];
  }

  return configuredRepos;
}
