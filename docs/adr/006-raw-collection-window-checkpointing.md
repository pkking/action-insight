# ADR-006: Raw Collection Window Checkpointing

**Status**: Implemented
**Date**: 2026-07-04  
**Context**: Long-running raw ETL backfills

## Decision

The raw Actions collector persists repository collection state after each completed top-level collection window, not only at the end of the full repository run. A saturated window is split and deduplicated before jobs are fetched. Its checkpoint advances only after every child and its bounded persistence succeed; interrupted, rate-limited, or unsplittably saturated windows are deferred without a checkpoint.

## Rationale

Current backfills can span many windows and several hundred API pages. If state is only written at the end of the full repository run, an interruption can discard a large amount of already-fetched progress. Window-level checkpoints keep the recovery point close to the actual work performed and make repeated resume runs materially more effective.

## Consequences

### Positive
- Completed raw backfills become durable earlier.
- Interrupted runs resume from the previous completed work unit without marking gaps complete.
- Long windows stop acting like a single large failure domain.

### Negative
- The collector performs more database writes during a run.
- Collection state may advance multiple times within one run, which makes logs noisier but improves resumability.

## Constraints

- Checkpointing must remain idempotent.
- Checkpoints must not advance for incomplete, rate-limited, or unsplittably saturated windows.
- Jobs must not be requested until a saturated window has been fully split and deduplicated.
- Final end-of-run persistence remains required so the latest merged state is always written.
