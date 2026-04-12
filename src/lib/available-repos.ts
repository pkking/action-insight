export type AvailableRepo = {
  owner: string;
  repo: string;
  slug: string;
  label: string;
};

export const AVAILABLE_REPOS: AvailableRepo[] = [
  {
    owner: 'vllm-project',
    repo: 'vllm-ascend',
    slug: 'vllm-project/vllm-ascend',
    label: 'vllm-project/vllm-ascend',
  },
];

export const DEFAULT_AVAILABLE_REPO = AVAILABLE_REPOS[0];

export function findAvailableRepo(owner: string | null, repo: string | null): AvailableRepo | null {
  return AVAILABLE_REPOS.find((item) => item.owner === owner && item.repo === repo) ?? null;
}
