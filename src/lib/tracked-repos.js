import yaml from 'js-yaml';

/**
 * @typedef {Object} TrackedRepo
 * @property {string} owner
 * @property {string} repo
 * @property {string} slug
 * @property {string} label
 */

/**
 * @param {string} content
 * @returns {TrackedRepo[]}
 */
export function parseTrackedReposYaml(content) {
  const parsed = yaml.load(content);
  const entries = Array.isArray(parsed?.repos) ? parsed.repos : [];

  return entries
    .map((entry) => {
      const slug = typeof entry === 'string' ? entry : entry?.repo;
      if (typeof slug !== 'string') {
        return null;
      }

      const [owner, repo] = slug.split('/');
      if (!owner || !repo) {
        return null;
      }

      return {
        owner,
        repo,
        slug,
        label: slug,
      };
    })
    .filter((repo) => repo !== null);
}

/**
 * @param {TrackedRepo[]} trackedRepos
 * @param {string | null} owner
 * @param {string | null} repo
 * @returns {TrackedRepo}
 */
export function resolveTrackedRepo(trackedRepos, owner, repo) {
  const match = trackedRepos.find((item) => item.owner === owner && item.repo === repo);
  return match ?? trackedRepos[0];
}

/**
 * @param {URLSearchParams} currentParams
 * @param {{ owner: string, repo: string }} selectedRepo
 * @returns {URLSearchParams}
 */
export function buildRepoSearchParams(currentParams, selectedRepo) {
  const nextParams = new URLSearchParams(currentParams.toString());
  nextParams.set('owner', selectedRepo.owner);
  nextParams.set('repo', selectedRepo.repo);
  return nextParams;
}
