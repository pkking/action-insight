# Action Insight

Monitor GitHub Actions CI/CD metrics with a clean, interactive dashboard.

## Architecture

This project uses a **split architecture**:

- **`main` branch** — Next.js frontend deployed to Vercel, reads pre-collected data from the `data` branch via GitHub Raw URLs
- **`data` branch** — ETL pipeline (GitHub Actions cron) that collects GitHub Actions runs/jobs data and writes daily JSON files

```
┌─────────────────────┐         ┌─────────────────────┐
│  main branch        │         │  data branch        │
│  (Vercel)           │◄────────│  (GitHub Actions)   │
│  Next.js Dashboard  │  Raw    │  ETL Pipeline       │
│  Read-only          │  JSON   │  Writes daily JSON  │
└─────────────────────┘         └─────────────────────┘
```

## Getting Started

### Frontend (main branch)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Note**: The frontend reads data from the `data` branch. If no data has been collected yet, you'll see an error. Run the ETL pipeline first or manually trigger the workflow.

### ETL Pipeline (data branch)

The ETL pipeline runs automatically every hour via GitHub Actions.

### Default collection behavior

With the current collector, history backfill is **oldest-first by default**.

- If a repo has missing history inside the retained window, collection resumes from the earliest missing retained day and keeps moving toward today.
- Progress is persisted in `data/<owner>/<repo>/index.json` through `backfill_cursor`.
- This makes large repositories practical to fill in over multiple workflow runs without re-scanning the newest windows first.
- If history is already complete, normal incremental collection continues using the existing index metadata.

### Run the workflow manually

1. Go to **Actions** → **Collect CI Data**.
2. Click **Run workflow**.
3. Optionally fill the workflow inputs:
   - `repo_name`: collect only one `owner/repo`
   - `force`: restart history backfill from the earliest retained day
   - `reverse`: collect from today backward instead of oldest-first

### Recommended ways to backfill history in GitHub Actions

For a very large repo, let the scheduled workflow do the work gradually first.

#### Method 1: Let schedule fill history progressively

Use the default scheduled workflow with no extra flags.

- Add the target repo to `etl/repos.yaml`.
- Let the hourly workflow keep running.
- Each run will continue from the earliest missing day until the retained window is filled up to today.

This is the safest default because it naturally spreads GitHub API usage over time.

#### Method 2: Focus on one large repo

Use **Run workflow** and set only `repo_name`.

This is useful when one repository has much more Actions volume than the rest and you want the workflow budget spent on that repo alone.

#### Method 3: Restart a repo's retained backfill from the beginning

Use **Run workflow** with:

- `repo_name`: `owner/repo`
- `force`: `true`

This tells the collector to restart from the earliest day inside `RETENTION_DAYS` and walk forward again. Use it when you changed collection logic, deleted some retained files, or want to rebuild the retained window for a single repo.

#### Method 4: Temporarily prioritize newest data first

Use **Run workflow** with:

- `repo_name`: `owner/repo`
- `reverse`: `true`

This makes the collector start from today and walk backward. Use it when the immediate goal is to inspect recent failures quickly instead of completing the oldest missing history first.

### Recommended rollout for a newly added high-volume repository

If you are onboarding a repository with very dense GitHub Actions history, use this sequence:

1. Add the repo to `etl/repos.yaml`.
2. For the first few runs, use **Run workflow** with `repo_name=owner/repo` and leave `reverse=false`.
3. Let the workflow continue oldest-first until the retained window is mostly filled.
4. Only use `force=true` if you intentionally want to restart retained backfill for that repo.
5. Only use `reverse=true` when you temporarily care more about recent runs than historical completeness.
6. After the repo is mostly caught up, remove the manual `repo_name` focus and let the scheduled workflow maintain it normally.

In practice, this means:

- first access: `repo_name` only
- rebuild retained history: `repo_name` + `force=true`
- urgent recent data: `repo_name` + `reverse=true`
- steady-state maintenance: no manual flags

### Run locally

Install dependencies and run the collector directly:

```bash
npm install
GITHUB_TOKEN=your_token TARGET_REPOS="owner/repo" RETENTION_DAYS=90 npx tsx etl/scripts/collect.ts
```

#### Local examples

Collect one repo with the default oldest-first history backfill behavior:

```bash
GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo owner/repo
```

Restart retained backfill from the earliest day:

```bash
GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo owner/repo --force-full-backfill
```

Collect from today backward:

```bash
GITHUB_TOKEN=your_token npx tsx etl/scripts/collect.ts --repo owner/repo --reverse
```

## Deploy on Vercel

Deploy the `main` branch to Vercel:

1. Connect your repository to [Vercel](https://vercel.com/new)
2. Set the deploy branch to `main`
3. Deploy

## Data Format

Data is stored as daily JSON files in the `data/` directory on the `data` branch:

```
data/
├── index.json          # Index of available dates per repo
├── 2024-01-16.json     # Daily runs + jobs data
└── 2024-01-15.json
```
