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
- `SUPABASE_DB_SSL` — Optional migration SSL mode. Use `no-verify` when the database connection presents a self-signed certificate chain in CI.

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
- Runs with cached jobs in Supabase skip the per-run jobs API call; missing jobs are refetched even when the run row already exists.
- Raw collection only writes workflow runs and jobs. PR artifact rebuilding is a separate step that reads existing Supabase `runs` rows and writes `pr_metrics` and `pr_workflows`.
- PR artifact rebuilding resolves missing run-to-PR links from, in order: run payload refs, Supabase's `pr_resolution_cache`, the commits API, and a small Search API fallback. Set `PR_ARTIFACT_SEARCH_RESOLUTION_LIMIT` to tune the fallback budget; the default is `5`.

### Run a workflow manually

1. Go to **Actions** → **Collect CI Data - \<repo\>**.
2. Click **Run workflow**.
3. Optionally fill the workflow inputs:
   - `force`: restart history backfill from the earliest retained day
   - `reverse`: collect from today backward instead of oldest-first

To rebuild PR metrics from already-collected raw runs, use **Actions** → **Rebuild PR Artifacts** and provide `repo`, plus optional `start_date` and `end_date` inputs.

### Run locally

```bash
npm install
SUPABASE_DB_URL=postgresql://... SUPABASE_DB_SSL=no-verify npm run migrate:supabase
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

Rebuild PR artifacts from existing Supabase runs:

```bash
GITHUB_TOKEN=your_token SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key npm run rebuild:pr-artifacts -- --repo owner/repo --start-date 2026-05-01 --end-date 2026-05-24
```

### Local maintenance tools

Use these scripts for local recovery, backfills, and validation:

| Tool | Use when | Command |
| --- | --- | --- |
| Supabase migration | Schema changed, a fresh database is being prepared, or ETL/rebuild jobs need the latest tables/functions. | `SUPABASE_DB_URL=postgresql://... SUPABASE_DB_SSL=no-verify npm run migrate:supabase` |
| Raw CI collection | `runs` or `jobs` are stale or missing. This fetches GitHub Actions runs/jobs and writes raw records only. | `GITHUB_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx etl/scripts/collect.ts --repo owner/repo` |
| PR artifact rebuild | Raw runs already exist but PR metrics are stale, missing, or partially resolved. Prefer a bounded date range. | `GITHUB_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run rebuild:pr-artifacts -- --repo owner/repo --start-date yyyy-mm-dd --end-date yyyy-mm-dd` |
| Legacy PR rebuild entry | Existing local notes still reference the old filename. It delegates to the new rebuild script. | `npx tsx etl/scripts/rebuild-pr-artifacts-local.ts --repo owner/repo` |
| Verification | Before handing off code changes. | `npm run lint` and `npm test` |

Operational guidance:

- Prefer `npm run rebuild:pr-artifacts` over rerunning raw collection when only `pr_metrics` or `pr_workflows` are stale.
- Use `--start-date` and `--end-date` for rebuilds whenever possible to reduce Supabase reads and GitHub PR lookup calls.
- Use `collect.ts --force-full-backfill` only when the retained raw history should be rebuilt from the earliest retained day.
- Use `collect.ts --reverse` when the newest data matters most and the historical backfill can continue later.
- `GITHUB_TOKEN` is optional for PR artifact rebuilds, but without it the rebuild can only use embedded run payload PR refs and `pr_resolution_cache`.

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
- **pr_resolution_cache** — Cached commit SHA to PR resolution state, including resolved PRs, not-found SHAs, failed lookups, and rate-limited attempts used to reduce GitHub API calls
- **collection_state** — Per-repo collection state (backfill cursor, history completion, latest date)

### Database migrations

Per-repo collection workflows run `npm run migrate:supabase` before collection. `npm run build` also runs the same migration automatically through `prebuild`, so production deployments can apply schema changes before the app starts serving new code. In protected runtimes such as GitHub Actions or Vercel, the script only runs when `AUTO_MIGRATE_SUPABASE=1` and the runtime is `main` or production; PR previews skip migration by default. Use `FORCE_SUPABASE_MIGRATION=1` only for explicit manual overrides. Set `SUPABASE_DB_SSL=no-verify` only for CI environments that cannot validate the database certificate chain.

### Adding a new repository

1. Add the repo to `etl/repos.yaml`.
2. Create a new workflow file: copy `.github/workflows/collect-repo-template.yml` and replace `{{OWNER}}/{{REPO}}`, `{{REPO_SLUG}}`, and `{{TOKEN_SECRET_NAME}}`.
3. Add the corresponding `<OWNER>_<REPO>` secret to the repository.
4. The Supabase `repos` table is auto-populated on first collection.
