# ADR-004: SQLite Database Files Stored via Git LFS

**Status**: Accepted, revised 2026-07-03
**Date**: 2026-06-14  
**Context**: PR #125 (CI collection failures), CI run #27470767070

## Decision

Per-repo SQLite database files (`etl/data/*.db`) remain tracked in the repository via **Git LFS** for recovery and manual migration workflows. Runtime reads and scheduled ETL writes use **Turso** as the default source of truth.

SQLite fallback/mirroring is disabled by default. It is enabled only when `ENABLE_SQLITE_FALLBACK=1` or `ENABLE_SQLITE_FALLBACK=true` is set for local recovery or an explicit Turso outage procedure.

## Rationale

The ETL pipeline (`etl/scripts/collect.ts`) originally wrote collected CI data to **two backends simultaneously**:

| Backend | Role | Storage |
|---------|------|---------|
| **Turso** (libSQL) | Primary — shared, queryable, remote | Cloud database |
| **SQLite** (libSQL local) | Explicit fallback/mirror — recovery only | `etl/data/<owner>-<repo>.db` |

This fallback was introduced after Turso write blocking in CI run #27448049473. After Turso write limits were lifted, default dual writes became a liability because they can create data drift, grow LFS objects, and make CI behavior depend on repository-tracked database snapshots. The revised behavior is:

1. **Turso is authoritative by default** — collection, rebuild, and runtime reads fail if Turso is unavailable.
2. **SQLite is opt-in** — recovery runs can explicitly enable `ENABLE_SQLITE_FALLBACK`.
3. **LFS files remain available** — existing `.db` snapshots can still bootstrap recovery or manual migration without being updated on every ETL run.

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

Workflows that intentionally use SQLite fallback must checkout LFS objects:

```yaml
- uses: actions/checkout@v6
  with:
    lfs: true
```

Routine Turso-backed collection does not commit updated `.db` files back to the repository. If a recovery workflow updates SQLite artifacts, it must commit them through the normal feature branch and PR process.

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

When Turso writes are blocked or unavailable, default ETL now fails fast so operators see the outage. To run an explicit recovery collection against local SQLite, set `ENABLE_SQLITE_FALLBACK=1`. In that mode, ETL reads Turso first, falls back to SQLite on Turso failure, and mirrors successful Turso writes to SQLite.

## Consequences

### Positive
- Turso remains the single default source of truth.
- Routine ETL no longer mutates repository-tracked `.db` files.
- Existing SQLite/LFS snapshots remain useful for manual disaster recovery.

### Negative
- Explicit recovery runs require operators to opt in with `ENABLE_SQLITE_FALLBACK`.
- Existing LFS objects still consume repository storage until intentionally removed.
- Recovery workflows must account for possible drift between Turso and old SQLite snapshots.

### Alternatives Considered
1. **Keep default dual writes** — rejected after Turso limits were lifted because it keeps growing LFS artifacts and risks silent divergence.
2. **Delete SQLite/LFS immediately** — rejected for now because existing snapshots are useful recovery artifacts.
3. **External object storage (S3, etc.)** — rejected: adds infrastructure complexity for a fallback path that is no longer routine.

## Related
- PR #123: `feat(etl): add SQLite fallback storage for ETL pipeline`
- PR #125: `fix(ci): resolve collection failures (LFS download + Turso write-block + initSqlite)`
- CI run #27448049473: Turso write-block + SQLITE_NOTADB failure
- CI run #27470767070: LFS objects 404 (objects not yet pushed to server)
