# Action Insight

Monitor GitHub Actions CI/CD metrics with a clean, interactive dashboard.

## Architecture

This project uses a **split architecture**:

- **`main` branch** — Next.js frontend deployed to Vercel, reads pre-collected data from the `data` branch via GitHub Raw URLs
- **`data` branch** — ETL pipeline (GitHub Actions cron) that collects GitHub Actions runs/jobs data and writes daily JSON files

```
┌─────────────────────┐         ┌─────────────────────┐
│  main branch        │         │  data branch         │
│  (Vercel)           │◄────────│  (GitHub Actions)    │
│  Next.js Dashboard  │  Raw    │  ETL Pipeline        │
│  Read-only          │  JSON   │  Writes daily JSON   │
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

The ETL pipeline runs automatically every 6 hours via GitHub Actions. To trigger manually:

1. Go to **Actions** → **Collect CI Data**
2. Click **Run workflow**

To run locally:

```bash
cd etl
npm install tsx octokit date-fns
GITHUB_TOKEN=your_token TARGET_REPOS="owner/repo" RETENTION_DAYS=90 npx tsx scripts/collect.ts
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
