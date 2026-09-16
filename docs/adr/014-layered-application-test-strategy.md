# ADR-014: Layered application test strategy

**Status**: Proposed  
**Date**: 2026-09-16

## Context

Action Insight combines a Next.js dashboard, PostgreSQL-backed server-side read models, API routes, schema migrations, and GitHub Actions collection/rebuild ETL. A browser-only test suite would require large, mutable datasets and external credentials to exercise all of these paths, making CI slow, costly, and non-deterministic. Conversely, unit tests alone cannot prove that dashboard filters, server rendering, URL state, database queries, and client interactions compose correctly.

Recent defects illustrate both boundaries: the all-repositories dashboard query generated invalid PostgreSQL row-value placeholders, and the UI wrote `days=7` while the server-side query parser ignored it. The first is inexpensive to lock down below the browser; the second needs an end-to-end assertion that a selected date range changes the rendered data.

## Decision

Adopt a layered test strategy with a small, deterministic browser E2E suite as the user-flow safety net, integration tests for persistence and server boundaries, and unit tests for pure logic.

### Browser E2E

Use Playwright against the application launched through Docker Compose with a dedicated, versioned **E2E fixture database**. The fixture database is a seeded PostgreSQL dataset whose rows deliberately cover multiple repositories, workflows, attempts, PRs, date boundaries, empty results, and enough PR observations to cross pagination boundaries. E2E tests must not call GitHub APIs, Supabase, Vercel, or live production-like databases.

The initial E2E suite covers these critical flows:

1. All-repositories homepage renders without a server error.
2. Repository switching and the 1/7/14/30-day quick ranges change the displayed population; custom date ranges are honored.
3. PR table pagination and drill-down work across more than two pages.
4. Cost, workflow, job, and queue tabs render their cards, charts/tables, and defined empty states.
5. Dark-mode and representative narrow-viewport rendering are smoke-tested.

Each E2E assertion should observe user-visible output or network behavior, not implementation-specific DOM structure. Browser tests remain focused on cross-boundary flows; they do not attempt combinatorial coverage of metrics or ETL edge cases.

### Integration tests

Use Vitest with an isolated PostgreSQL database or schema for tests that cross module, SQL, migration, and API-route boundaries. These tests own query semantics, dashboard read-model filter behavior, pagination/truncation contracts, schema migration behavior, ETL persistence, and artifact rebuild inputs/outputs. They use deterministic fixtures and local credentials only.

### Unit tests

Keep pure metric calculations, date/query parsing, configuration parsing, placeholder construction, and transformation edge cases in fast Vitest unit tests. A production bug is first protected at the lowest layer that reproduces its real failure mode; add an E2E regression only when the failure requires browser-to-server composition.

## Trade-offs

- Maintaining a fixture database and Playwright infrastructure adds setup work, but removes dependence on rate-limited external services and makes CI failures reproducible.
- E2E coverage is intentionally selective. It detects broken user journeys but does not replace SQL, ETL, or metric-level tests.
- Docker Compose makes the browser environment close to local production behavior, at the cost of a slower test job than unit tests. CI should run unit tests first, integration tests next, and E2E after build/fixture setup.

## Consequences

- New dashboard user flows must add or update an E2E scenario when a browser-visible cross-boundary regression is plausible.
- New SQL/ETL behavior requires integration coverage; new pure decision logic requires unit coverage. Do not use browser E2E as the only regression test for such changes.
- E2E fixtures are test assets, not operational data: they may contain no tokens, live repository payloads, or personally sensitive data, and must be reset for every run.
- GitHub API collection remains outside E2E. Its behavior is verified with mocked HTTP/integration fixtures and narrow, explicitly authorized manual collection checks.
- CI documentation and workflows must be updated when the proposed Playwright and fixture-database implementation is introduced.
