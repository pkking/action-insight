# ADR-004: SQLite Database Files Stored via Git LFS

**Status**: Accepted  
**Date**: 2026-06-14  
**Context**: PR #125 (CI collection failures), CI run #27470767070

## Decision

Per-repo SQLite database files (`etl/data/*.db`) are tracked in the repository via **Git LFS**. They serve as the **local fallback storage** for GitHub Actions runs/jobs data when the primary Turso database is unavailable (e.g., write quota exhausted, network issues, or plan limits).

## Rationale

The ETL pipeline (`etl/scripts/collect.ts`) writes collected CI data to **two backends simultaneously**:

| Backend | Role | Storage |
|---------|------|---------|
| **Turso** (libSQL) | Primary — shared, queryable, remote | Cloud database |
| **SQLite** (libSQL local) | Fallback — guaranteed local persistence | `etl/data/<owner>-<repo>.db` |

When Turso is write-blocked (as happened in CI run #27448049473), the SQLite files become the only source of truth for collected data. Committing them to the repo ensures:

1. **CI runners always have a working local database** — no bootstrap or manual setup required.
2. **Data survives Turso outages** — collection continues against SQLite, and data can be migrated back to Turso later.
3. **History is versioned** — database schema changes and data growth are tracked alongside code.

### Why Git LFS

The combined size of all `.db` files is **~530 MB** (as of June 2026):

| File | Size |
|------|------|
| `sgl-project-sglang.db` | 317 MB |
| `vllm-project-vllm-ascend.db` | 118 MB |
| `verl-project-verl.db` | 33 MB |
| `tile-ai-tilelang-ascend.db` | 16 MB |
| `triton-lang-triton-ascend.db` | 15 MB |
| `hiyouga-LlamaFactory.db` | 9 MB |
| `modelscope-ms-swift.db` | 6 MB |

These exceed GitHub's 100 MB per-file hard limit for regular git objects, making Git LFS the only viable option for storing them in-repo.

## Configuration

### `.gitattributes`

```
etl/data/*.db filter=lfs diff=lfs merge=lfs -text
```

### `.gitignore`

The `.db` files are **not** in `.gitignore` — they are tracked via LFS. Only temporary/cache files are ignored:

```
# No .gitignore entry for etl/data/*.db — tracked via LFS
```

### CI Workflow

All checkout steps in `.github/workflows/collect-all-repos.yml` must include `lfs: true`:

```yaml
- uses: actions/checkout@v6
  with:
    lfs: true
```

This ensures CI runners download the actual SQLite database binaries instead of LFS pointer text files.

## Known Issues & Resolutions

### LFS Push Failure (SSH "bad_permissions")

**Problem**: `git lfs push` defaults to SSH protocol (`git-lfs-authenticate`), which returns `{"auth_status":"bad_permissions","body":"Repository not found."}` for this repo.

**Resolution**: Set the LFS endpoint to HTTPS in the local repo config:

```bash
git config lfs.url "https://github.com/pkking/action-insight.git/info/lfs"
git lfs push --all origin main
```

This uses the `gh` auth token (HTTPS) instead of SSH keys for LFS transfers.

**Impact on CI**: CI runners use the `GITHUB_TOKEN` provided by GitHub Actions, which authenticates LFS pulls via HTTPS automatically. No `lfs.url` config is needed on runners — `actions/checkout@v6` with `lfs: true` works out of the box.

### Turso Write-Blocked

When Turso free-tier write quota is exhausted, all Turso operations fail with `BLOCKED: SQL write operations are forbidden`. The SQLite fallback handles this gracefully (see PR #125) — `ensureRepo()` catches the BLOCKED error and falls back to SELECT-only lookups.

## Consequences

### Positive
- CI always has a working local database without external dependencies
- Data collection continues even when Turso is unavailable
- Database schema and data growth are versioned with code

### Negative
- Repository clone requires Git LFS (~530 MB download)
- LFS bandwidth limits on GitHub Free (1 GB/month bandwidth, 1 GB storage)
- Contributors must have Git LFS installed (`git lfs install`)

### Alternatives Considered
1. **Don't track .db files** — rejected: CI runners would have no local database on first run.
2. **Generate .db files in CI** — rejected: would require full historical data re-collection on every fresh runner.
3. **External object storage (S3, etc.)** — rejected: adds infrastructure complexity; Git LFS is sufficient for current scale.

## Related
- PR #123: `feat(etl): add SQLite fallback storage for ETL pipeline`
- PR #125: `fix(ci): resolve collection failures (LFS download + Turso write-block + initSqlite)`
- CI run #27448049473: Turso write-block + SQLITE_NOTADB failure
- CI run #27470767070: LFS objects 404 (objects not yet pushed to server)
