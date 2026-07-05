# ADR-006: Raw Collection Window Checkpointing

**Status**: Accepted  
**Date**: 2026-07-04  
**Context**: Long-running raw ETL backfills

## Decision

The raw Actions collector now persists repository collection state after each completed top-level collection window, not only at the end of the full repository run. The collector still performs a final persistence pass at the end of the run, but intermediate checkpoints are written so partial progress survives interruptions, rate-limit aborts, and long-running window splits.

## Rationale

Current backfills can span many windows and several hundred API pages. If state is only written at the end of the full repository run, an interruption can discard a large amount of already-fetched progress. Window-level checkpoints keep the recovery point close to the actual work performed and make repeated resume runs materially more effective.

## Consequences

### Positive
- Partial raw backfills become durable earlier.
- Interrupted runs can resume from newer collection state.
- Long windows stop acting like a single large failure domain.

### Negative
- The collector performs more database writes during a run.
- Collection state may advance multiple times within one run, which makes logs noisier but improves resumability.

## Constraints

- Checkpointing must remain idempotent.
- Partial checkpoints must not invent empty dates for windows that have not finished.
- Final end-of-run persistence remains required so the latest merged state is always written.
