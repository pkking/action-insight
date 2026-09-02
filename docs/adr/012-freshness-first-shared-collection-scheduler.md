# ADR-012: Schedule raw collection by freshness before backfill

**Status**: Accepted  
**Date**: 2026-09-02

## Context

The raw collector previously assigned repositories to token strings by list position and finished every window for one repository before moving to the next. An idle credential therefore could not help another repository, and a long history backfill could delay fresh data for every later **Tracked Repository**.

## Decision

Build a collection plan from the durable checkpoint state. The first (recent) **Collection Window** for every Tracked Repository has higher priority than all remaining history windows. A shared queue dispatches one window at a time to each authenticated GitHub identity. A repository has at most one active window, and a lane is serial by default.

Token strings are resolved to the authenticated GitHub identity and duplicate identities share one lane. Before dispatch, each lane reads its core budget and stops dispatching when its remaining requests reach `GITHUB_RATE_LIMIT_RESERVE` (default `10`). A rate-limited lane returns its current work unit to the shared queue so another identity can claim it. A unit retains the existing split, deduplication, jobs, checkpoint, and validator ordering.

## Consequences

- Recent tracked-workflow collection completes across repositories before history backfill starts.
- Repositories are no longer permanently assigned to a token string.
- A duplicate token cannot overspend a shared identity budget through concurrent lanes.
- Identity discovery and one rate-limit read add a small fixed cost per supplied credential.

## Constraints

- A Collection Window remains the persistence/checkpoint unit; split children must still finish before jobs are fetched.
- The reserve is enforced for requests issued by the collector after the lane is initialized; identity and rate-limit discovery occur before wrapping the lane.
- Deferred units are not successful collection results and remain recoverable from durable checkpoints.
- Transaction batching and detailed liveness reporting are separate rollout slices.
