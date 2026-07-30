# ADR-007: Buildkite Collection Adapter

**Status**: Accepted  
**Date**: 2026-07-30  
**Context**: Multi-provider raw CI collection

## Decision

Extend the existing raw collector with a Buildkite REST adapter. A tracked repository may add `buildkite_pipelines` entries containing an organization and pipeline slug; `github_actions: false` makes it Buildkite-only, while GitHub Actions remains enabled by default. During each existing collection window, the collector fetches those pipelines with `created_from` / `created_to`, normalizes builds and jobs into the current `Run` / `Job` seam, and persists them through the unchanged Turso/SQLite writers.

Buildkite authentication uses `BUILDKITE_TOKEN` with `read_builds`; GitHub collection continues to use `GITHUB_TOKEN`. Only tokens required by the configured sources are mandatory.

Provider normalization is:

- Build → workflow run and workflow attempt; Buildkite rebuilds are distinct builds and therefore attempt `1`.
- Buildkite job → tracked job. Buildkite exposes no nested command-step timing, so no synthetic step rows are created.
- Workflow identity → `buildkite:<organization>/<pipeline>`, with build branch as workflow ref.
- Native UUID identities → deterministic negative safe integers derived from SHA-256 of the provider identity. GitHub IDs remain unchanged and positive. Build and job URLs retain the native auditable identity.
- Build/job states are mapped to the existing GitHub-compatible status and conclusion vocabulary.

The collection checkpoint remains repository-scoped. GitHub and Buildkite results for the same window are merged before the checkpoint, so one source cannot independently mark a date complete.

## Trade-offs

### Positive

- Reuses the current analytics, storage, retention, and checkpointing pipeline.
- Adds no runtime dependency and no breaking schema migration.
- Existing GitHub collection behavior and IDs remain unchanged.

### Negative

- Buildkite job timing appears at the Job level; Step analysis is unavailable because the API does not expose nested command timing.
- Hashed integer IDs have a theoretical collision risk. The adapter detects collisions within each response; if collection scale makes this material, migrate storage keys to provider plus native string ID.
- Cross-provider status names lose some Buildkite-specific detail; native links remain available for investigation.

## Alternatives Considered

1. Add provider/native string keys throughout the schema. Rejected for the first adapter because it requires a breaking foreign-key migration across raw, attempt, PR, and UI queries.
2. Store Buildkite in separate tables. Rejected because it duplicates all analytics and prevents cross-provider reports.
3. Treat Buildkite jobs as Step rows. Rejected because it would hide queue time and misrepresent the provider model.

## Consequences and Constraints

- `buildkite_pipelines` configuration must be validated locally; online validation checks pipeline access when `BUILDKITE_TOKEN` is available.
- Pagination, HTTP 429 reset headers, transient errors, incomplete timestamps, retried jobs, and mixed GitHub/Buildkite repositories require tests.
- Reports must describe Buildkite Job coverage instead of claiming nested Step coverage.
