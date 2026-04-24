import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { rebuildPullRequestArtifacts } from './pr-artifacts';

interface IndexFile {
  files?: unknown;
}

interface ReposConfig {
  repos?: unknown;
}

function getRepoDir(repo: string): string {
  const [owner, name] = repo.split('/');
  return path.join(process.cwd(), 'data', owner, name);
}

function readReposConfig(): string[] {
  const reposConfigPath = path.join(process.cwd(), 'etl', 'repos.yaml');
  const content = fs.readFileSync(reposConfigPath, 'utf8');
  const config = yaml.load(content) as ReposConfig | null;

  return Array.isArray(config?.repos) ? config.repos.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readIndex(repo: string): string[] {
  const indexPath = path.join(getRepoDir(repo), 'index.json');
  try {
    if (!fs.existsSync(indexPath)) {
      return [];
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexFile;
    return Array.isArray(index.files) ? index.files.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch (error) {
    console.warn(`Warning: Failed to read index for ${repo}:`, error instanceof Error ? error.message : error);
    return [];
  }
}

function parseTargetRepos(argv: string[]): string[] {
  const explicitRepos: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--repo' || arg === '-r') && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      explicitRepos.push(argv[index + 1]);
      index += 1;
    }
  }

  return explicitRepos.length > 0 ? explicitRepos : readReposConfig();
}

async function main() {
  const targetRepos = parseTargetRepos(process.argv.slice(2));

  for (const repoKey of targetRepos) {
    const [owner, repo] = repoKey.split('/');
    if (!owner || !repo) {
      console.warn(`Skipping invalid repo key: ${repoKey}`);
      continue;
    }

    const repoDir = getRepoDir(repoKey);
    if (!fs.existsSync(repoDir)) {
      console.warn(`Skipping ${repoKey}: ${repoDir} does not exist`);
      continue;
    }

    const files = readIndex(repoKey);
    if (files.length === 0) {
      console.warn(`Skipping ${repoKey}: no retained files in index.json`);
      continue;
    }

    await rebuildPullRequestArtifacts({
      owner,
      repo,
      repoKey,
      repoDir,
      files,
      storage: {
        readDayData: (currentRepo: string, date: string) => {
          const filePath = path.join(getRepoDir(currentRepo), `${date}.json`);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { runs?: unknown[] };
            return { runs: Array.isArray(data.runs) ? data.runs : [] };
          } catch (error) {
            console.warn(
              `Warning: Failed to read data for ${currentRepo} on ${date}:`,
              error instanceof Error ? error.message : error
            );
            return { runs: [] };
          }
        },
      },
      log: (...args: unknown[]) => console.log(...args),
      warn: (...args: unknown[]) => console.warn(...args),
    });

    console.log(`Rebuilt PR artifacts for ${repoKey}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
