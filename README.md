# Action Insight

Monitor GitHub Actions CI/CD metrics with a clean, interactive dashboard.

## Architecture

This project uses **Supabase as the primary data store** with per-repo GitHub Actions for data collection:

- **Frontend**: Deployed to Vercel, reads data from Supabase
- **ETL Pipeline**: Per-repo GitHub Actions collect runs/jobs data and write directly to Supabase
- **Data**: Stored in Supabase (runs, jobs, pr_metrics tables)
- **Collection state**: Tracked in Supabase `collection_state` table (backfill cursor, history completion)

```
┌─────────────────────────────────────────────────────┐
│                  main branch                        │
│                                                     │
│  ┌─────────────────┐                                │
│  │  Next.js        │                                │
│  │  Dashboard      │  ◄─────────────────────────┐   │
│  │  (Vercel)       │                            │   │
│  └─────────────────┘                            │   │
│                                                  │   │
│  ┌─────────────────┐   ┌─────────────────┐      │   │
│  │  collect-xxx    │   │  collect-yyy    │      │   │
│  │  (per-repo)     │   │  (per-repo)     │      │   │
│  └────────┬────────┘   └────────┬────────┘      │   │
│           │                     │                │   │
│           └──────────┬──────────┘                │   │
│                      │                            │   │
│              ┌───────▼────────┐                   │   │
│              │    Supabase    │───────────────────┘   │
│              │  (runs, jobs,  │                       │
│              │  pr_metrics)   │                       │
│              └────────────────┘                       │
└─────────────────────────────────────────────────────┘
```

Each repository has its own workflow file (`.github/workflows/collect-<owner>-<repo>.yml`) with its own GitHub token secret to reduce rate limit issues.

**Required secrets** (configure in repository Settings → Secrets):
- `<OWNER>_<REPO>` — GitHub token for each repo's workflow (uppercase, hyphens → underscores)
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `SUPABASE_DB_URL` — PostgreSQL connection string for automatic schema migrations before ETL collection and production builds. If absent, the migration script also checks `DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`, and `POSTGRES_PRISMA_URL`.

## Getting Started

### Frontend (main branch)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Note**: The frontend reads data from Supabase. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

### ETL Pipeline

Each repository has its own scheduled workflow that runs hourly. Workflows are named `collect-<owner>-<repo>.yml`.

### Default collection behavior

History backfill is **oldest-first by default**.

- If a repo has missing history inside the retained window, collection resumes from the earliest missing retained day.
- Progress is persisted in the Supabase `collection_state` table through `backfill_cursor`.
- If history is already complete, normal incremental collection continues.

### Run a workflow manually

1. Go to **Actions** → **Collect CI Data - \<repo\>**.
2. Click **Run workflow**.
3. Optionally fill the workflow inputs:
   - `force`: restart history backfill from the earliest retained day
   - `reverse`: collect from today backward instead of oldest-first

### Run locally

```bash
npm install
SUPABASE_DB_URL=postgresql://... npm run migrate:supabase
GITHUB_TOKEN=your_token SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key npx tsx etl/scripts/collect.ts --repo owner/repo
```

Restart retained backfill from the earliest day:

```bash
GITHUB_TOKEN=your_token SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key npx tsx etl/scripts/collect.ts --repo owner/repo --force-full-backfill
```

Collect from today backward:

```bash
GITHUB_TOKEN=your_token SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key npx tsx etl/scripts/collect.ts --repo owner/repo --reverse
```

## Deploy on Vercel

Deploy the `main` branch to Vercel:

1. Connect your repository to [Vercel](https://vercel.com/new)
2. Set the deploy branch to `main`
3. Configure environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a database connection URL such as `SUPABASE_DB_URL` or `POSTGRES_URL_NON_POOLING`

## Database Schema

Data is stored in Supabase with the following tables (see `supabase/schema.sql`):

- **repos** — Repository registry (owner, repo)
- **runs** — Workflow runs (GitHub run ID, name, branch, status, duration, date)
- **jobs** — Individual jobs within runs (queue duration, execution duration)
- **pr_metrics** — PR-level CI metrics summaries
- **pr_workflows** — Linking table between PR metrics and runs
- **pr_resolution_cache** — Cached commit SHA to PR number associations used to reduce GitHub API calls
- **collection_state** — Per-repo collection state (backfill cursor, history completion, latest date)

### Database migrations

Per-repo collection workflows run `npm run migrate:supabase` before collection. `npm run build` also runs the same migration automatically through `prebuild`, so production deployments can apply schema changes before the app starts serving new code. In protected runtimes such as GitHub Actions or Vercel, the script only runs when `AUTO_MIGRATE_SUPABASE=1` and the runtime is `main` or production; PR previews skip migration by default. Use `FORCE_SUPABASE_MIGRATION=1` only for explicit manual overrides.

### Adding a new repository

1. Add the repo to `etl/repos.yaml`.
2. Create a new workflow file: copy `.github/workflows/collect-repo-template.yml` and replace `{{OWNER}}/{{REPO}}`, `{{REPO_SLUG}}`, and `{{TOKEN_SECRET_NAME}}`.
3. Add the corresponding `<OWNER>_<REPO>` secret to the repository.
4. The Supabase `repos` table is auto-populated on first collection.
