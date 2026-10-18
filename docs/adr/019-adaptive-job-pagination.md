# ADR-019: Adaptive pagination for GitHub Actions jobs

## Status

Accepted

## Context

During the October 2026 SGLang backfill, valid attempts repeatedly returned GitHub 502 responses at `per_page=100`, while smaller pages succeeded. Retrying the same large page consumed quota without durable progress. A temporary repository-specific fetcher recovered the data; keeping a separate collector would duplicate selection, normalization, persistence, and credential handling.

## Decision

Both `collect.ts` and `backfill-missing-jobs.ts` use `github-jobs.ts` for jobs pagination. Start at 100 jobs per page to preserve normal collection cost. After the caller exhausts its bounded transient retries on a 502, 503, or 504, reduce the page size through **100 → 30 → 10 → 1**. Keep each caller's retry policy, quota handling, normalization, and write path. Emit a credential-free fallback event identifying the attempt, failed page, and new size.

A size change discards the incomplete pass and restarts at page 1. Page numbers depend on page size; continuing at the old page number could omit jobs. Deduplicate by job ID within the successful pass, and return only after its terminal short page. Missing/malformed `jobs` arrays and invalid job IDs are errors, not empty results.

Other errors, including rate limits, authentication failures, 404/422, and persistent errors at size 1, propagate to the existing caller. In particular, the collector no longer substitutes the latest run's jobs after a rerun-specific endpoint fails, and backfill no longer writes a successful empty attempt for an inaccessible endpoint. A valid `jobs: []` response remains a legitimate zero-job result. Only a complete successful fetch reaches the existing write path; failed windows retain their checkpoint/validator semantics.

## Trade-offs and impact

- Restarting a pass costs additional requests but keeps page-size changes complete and atomic at the fetch boundary. Small pages are a bounded fallback, not the default for every attempt.
- Limiting fallback to gateway/service errors avoids spending more quota on permission errors or disguising malformed responses. Persistent failures remain visible and can be retried by repository/window.
- One shared module replaces the temporary pagination workaround without introducing campaign markers, repository/date constants, parallel writers for one repository, or a second CLI. Existing identity-deduplicated lanes and jobs concurrency remain unchanged.
- No database/schema migration, new cache, or PR metric rebuild is required. Previously confirmed empty attempts may still be revisited by the existing missing-jobs repair query; this decision adds no new durable empty-result cache.

## Follow-up constraints

Tests must cover later-page fallback with a full restart, all size transitions and exhaustion, rerun routing, rate-limit/error propagation, malformed versus valid-empty responses, job/step metadata preservation, and failure without writes. Maintain current/historical workflow selection according to [ADR-010](010-tracked-workflow-run-collection.md); do not use pagination recovery to silently replace a workflow or attempt identity.
