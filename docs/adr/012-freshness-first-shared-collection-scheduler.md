# ADR-012: Schedule raw collection by freshness before backfill

**Status**: Accepted  
**Date**: 2026-09-02

## Context

The raw collector previously assigned repositories to token strings by list position and finished every window for one repository before moving to the next. An idle credential therefore could not help another repository, and a long history backfill could delay fresh data for every later **Tracked Repository**.

## Decision

Build a collection plan from the durable checkpoint state. The first (recent) **Collection Window** for every Tracked Repository has higher priority than all remaining history windows. A shared queue dispatches one window at a time to each authenticated GitHub identity. A repository has at most one active window, and a lane is serial by default.

Token strings are resolved to the authenticated GitHub identity and duplicate identities share one lane. Before dispatch, each lane reads its core budget and stops dispatching when its remaining requests reach `GITHUB_RATE_LIMIT_RESERVE` (default `10`). A rate-limited lane returns its current work unit to the shared queue so another identity can claim it. A unit retains the existing split, deduplication, jobs, checkpoint, and validator ordering.

The shared scheduler emits a `COLLECTION_HEARTBEAT_SECONDS` heartbeat (default `60`) while work is active, immediate messages when a window completes or is released by a rate-limited lane, terminal messages naming every deferred window, and one collection summary reporting completed, failed, deferred, and retried counts. These are console-only operational signals: no collection state advances on failure or deferral, and no external telemetry is introduced. Transient GitHub request failures and retryable PostgreSQL errors (such as serialization failures, deadlocks, and connection drops) retry at most three times with exponential backoff and 50–150% jitter. A rate-limited identity lane returns its current work unit for another lane to claim. A secondary limit with a positive `Retry-After` keeps that lane inactive until the interval ends, then resumes it only when work remains; a depleted lane stops for the current cycle with its reset timestamp logged. When all lanes are depleted, the collection cycle ends partial with explicit coverage, cooldown, and retry reporting rather than an unhandled abort. The scheduler logs `Retry-After`, reset, or next-cycle cooldown context.

## Consequences

- Recent tracked-workflow collection completes across repositories before history backfill starts.
- Repositories are no longer permanently assigned to a token string.
- A duplicate token cannot overspend a shared identity budget through concurrent lanes.
- Identity discovery and one rate-limit read add a small fixed cost per supplied credential.
- Long-running collection remains observable without adding a durable liveness data model or external telemetry dependency.

## Constraints

- A Collection Window remains the persistence/checkpoint unit; split children must still finish before jobs are fetched.
- The reserve is enforced for requests issued by the collector after the lane is initialized; identity and rate-limit discovery occur before wrapping the lane.
- Deferred units are not successful collection results and remain recoverable from durable checkpoints.
- A rate-limited lane must not retry a work unit directly; it releases the unit before waiting or stopping so another identity can claim it.
- Only an explicit positive `Retry-After` on a non-depleted lane schedules an in-cycle resume; reset-only and depleted lanes end for the current cycle.
- Incomplete collection cycles with deferred windows end partial with explicit coverage reporting and do not fail the process when partial results were saved.
- Transaction batching is a separate rollout slice.
- `COLLECTION_HEARTBEAT_SECONDS` accepts whole seconds from `1` through `2147483`; any other value suppresses heartbeats but not terminal summaries, avoiding Node timer overflow.
