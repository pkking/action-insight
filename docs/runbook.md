# Action Insight ETL Runbook & Benchmark Specification

## Benchmark Specification (#204)

This runbook defines the reproducible cold and warm 3-day PostgreSQL-snapshot benchmark methodology and performance acceptance criteria for Action Insight's local ETL collector.

### Acceptance Criteria

1. **Warm REST Request Reduction**: At least **50% fewer** GitHub Actions REST requests in a warm rerun compared to the cold run for the identical 3-day historical window.
2. **Warm Wall-Clock Speedup**: At least **2x faster** wall-clock execution for the warm rerun.
3. **Data Completeness**: Zero completeness regression. The warm rerun must preserve identical complete sets of:
   - Tracked Workflow Runs (`id`)
   - Workflow Attempts (`run_id`, `run_attempt`)
   - Tracked Jobs (`id`)
   - Eligible Steps (`name`, `number`, `duration_seconds`)
4. **Failure Isolation**: Partial network/DNS failures (`EAI_AGAIN`) or rate-limit cooldowns must be isolated to the affected lane/repo and excluded from success comparison.

### Representative Matrix

Benchmarks evaluate the historical 3-day window across three representative volume tiers as well as the full 13-repository fleet:

| Tier | Representative Repository | Workflow Files | Volume Characteristics |
|---|---|---|---|
| **Small** | `ascend/pytorch` | 1 | Low volume (~100 stored runs) |
| **Medium** | `triton-lang/triton` | 2 | Moderate volume (~1,800 stored runs) |
| **High** | `sgl-project/sglang` | 4 | High volume (>250,000 stored runs, intensive job fanout) |
| **All** | All 13 configured repositories | 32 | Full fleet collection cycle |

### Reproducing the Benchmark

#### Prerequisites

1. Local PostgreSQL running and healthy via Docker:
   ```bash
   docker compose up -d postgres
   export PG_DATABASE_URL='postgresql://action_insight:action_insight@localhost:5433/action_insight'
   ```
2. Authenticated GitHub token (via `gh auth login`, `gh-token.txt`, or `GITHUB_TOKEN`):
   ```bash
   export GITHUB_TOKEN="$(gh auth token)"
   ```

#### Running the Benchmark Suite

Run the benchmark across the representative repositories:
```bash
npm run benchmark:collection -- --representatives
```

Run the benchmark for a single repository:
```bash
npm run benchmark:collection -- --repo sgl-project/sglang --days 3
```

Run the benchmark for all 13 configured repositories:
```bash
npm run benchmark:collection -- --all --days 3
```

Emit machine-readable JSON:
```bash
npm run benchmark:collection -- --representatives --json
```

### Measured Baseline vs Architecture Targets

| Metric | Measured Baseline (2026-09-01) | Target / Accepted Architecture |
|---|---|---|
| `sglang` High-Volume Wall-Clock | 92m 50s (5,291 requests) | Warm rerun: < 5m, < 100 requests (304 revalidation) |
| Jobs Request Share | 64.8% of total requests | Skip unchanged completed attempts via attempt-cache |
| Run List Pagination | Saturated window splitting | Conditional `If-None-Match` 304 revalidation |
| Warm Request Reduction | 0% (re-fetched jobs serially) | **>= 50%** (typically > 90% via 304 + attempt cache) |
| Warm Wall-Clock Speedup | 1.0x | **>= 2x** (typically > 5x) |
| Identity Completeness | Preserved | Preserved 100% |
