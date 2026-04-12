# Repo Selection Panel Implementation Plan

**Status:** active  
**Date:** 2026-04-12  
**Origin:** `docs/superpowers/specs/2026-04-10-repo-selection-panel-design.md`

## Problem Frame

The dashboard in `src/app/page.tsx` can already fetch any `owner` / `repo` pair through `src/lib/data-fetcher.ts`, but the page still hardcodes `vllm-project/vllm-ascend`. The requirements doc now narrows the feature to repositories that already have readable data under `data/<owner>/<repo>/index.json`, with the selection panel still visible even when only one repo is available.

## Scope

- Add a visible repository selection panel near the top of the dashboard.
- Drive the active repository from `owner` and `repo` URL search params.
- Source selectable repositories from data that is actually available to the frontend.
- Reset stale repo-specific UI state when the selected repository changes.
- Add page-level tests covering repo selection behavior.

## Non-Goals

- Reading selectable repos directly from `etl/repos.yaml`.
- Showing repos that are tracked but do not yet have data.
- Adding freeform `owner/repo` input.
- Refactoring the page into multiple routes or server components.

## Requirements Traceability

- **R1-R2:** The selectable repo list must come from available data, not from ETL tracking config.
- **R3-R6:** Changing repo must refresh the dashboard, preserve shareable URL state, and clear stale expanded/zoom state.
- **R7:** The selection panel remains visible even for a single available repo.

## Planning Context

- Current local data only exposes `vllm-project/vllm-ascend`, so the first implementation must still render a one-item panel cleanly.
- The repository does not currently have a page test harness. `package.json` has no `test` script and no Testing Library / Vitest setup.
- There is already helper logic in `src/lib/tracked-repos.js`, but it is oriented around parsing YAML. That file is useful as reference for URL param handling, not as the final source of truth for this feature.
- The codebase already uses a single large client page, URL-backed filters, and a fetcher abstraction. Local patterns are sufficient; no external docs research is needed.

## Key Decisions

- **Use an available-repo source, not mirrored YAML config.**  
  Rationale: mirroring `etl/repos.yaml` into frontend code creates dual maintenance and exposes repos that may 404.

- **Keep repo selection in the existing client page.**  
  Rationale: this matches current architecture and keeps the change bounded to state, routing, and rendering logic in `src/app/page.tsx`.

- **Add a small page test harness before feature work.**  
  Rationale: the repo currently lacks page-level test infrastructure, and the feature is mostly state/routing behavior that benefits from regression tests.

- **Treat repo changes like a fetch-context switch.**  
  Rationale: expanded rows, zoom bounds, and in-memory runs are all repo-specific and must reset together to avoid stale UI.

## Implementation Units

### Unit 1: Add page test infrastructure

**Files**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`

**Plan**
- Add a `test` script to `package.json`.
- Add dev dependencies for `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, and `@testing-library/user-event`.
- Configure `vitest.config.ts` with `jsdom` and the existing `@` alias for `src/`.
- Create `src/test/setup.ts` to register `@testing-library/jest-dom/vitest`.

**Pattern references**
- `package.json`
- `tsconfig.json`

**Test scenarios**
- The harness should support plain `npm test`.
- A minimal `src/app/page.test.tsx` smoke test should execute successfully once the harness exists.

### Unit 2: Introduce an available-repo source for the page

**Files**
- Create or modify: `src/lib/available-repos.ts` or equivalent repo-availability module
- Reference only: `data/<owner>/<repo>/index.json`

**Plan**
- Add a small frontend-safe module that exports the repositories the UI may select.
- Represent each item as `{ owner, repo, slug, label }`.
- Seed the module from the repos that actually have data today, not from `etl/repos.yaml`.
- Keep the module intentionally small and explicit so the first implementation is stable; do not design a generalized discovery pipeline in this step.

**Pattern references**
- `src/lib/tracked-repos.js`
- `data/vllm-project/vllm-ascend/index.json`

**Test scenarios**
- The module should expose at least one repo.
- The default available repo should be the first exported repo.
- Valid and invalid `owner` / `repo` URL selections should resolve predictably to either a matching repo or the default repo.

### Unit 3: Update dashboard repo state, routing, and panel UI

**Files**
- Modify: `src/app/page.tsx`

**Plan**
- Read `owner` and `repo` from `useSearchParams()`.
- Resolve them against the available-repo source and fall back to the default available repo.
- Replace the hardcoded `fetchRuns('vllm-project', 'vllm-ascend', days)` call with `fetchRuns(selectedRepo.owner, selectedRepo.repo, days)`.
- Include `owner` and `repo` in the `router.replace(...)` sync logic while preserving the existing filter/sort params.
- Add a `Tracked Repositories` panel above the date controls, rendered even when only one repo is available.
- On repo switch, clear `expandedRunId`, `zoomLeft`, `zoomRight`, `refAreaLeft`, and `refAreaRight`.
- Reset in-memory runs before the new fetch resolves so stale data is not shown under the new repo label.
- Update empty and error messaging to mention `selectedRepo.slug` where it helps interpret failures.

**Pattern references**
- `src/app/page.tsx`
- `src/lib/data-fetcher.ts`

**Test scenarios**
- Missing URL params fetch the default available repo.
- Valid URL params fetch the matching available repo.
- Invalid URL params fall back to the default available repo.
- Clicking a repo button updates the active repo state and triggers URL replacement.
- Switching repo clears expanded-row and zoom state before showing new data.
- The panel renders even when the available repo list has length 1.

### Unit 4: Add focused page tests for repo selection

**Files**
- Create: `src/app/page.test.tsx`

**Plan**
- Mock `next/navigation` hooks for pathname, router, and search params.
- Mock `fetchRuns` from `src/lib/data-fetcher.ts`.
- Stub `recharts` components so the page can render in jsdom without chart implementation noise.
- Cover the URL defaulting/fallback logic and the repo panel behavior.
- Keep the tests focused on state transitions and fetch arguments rather than visual snapshots.

**Pattern references**
- `src/app/page.tsx`
- `src/lib/tracked-repos.test.mjs`

**Test scenarios**
- `Dashboard` fetches the default repo when no repo params are present.
- `Dashboard` honors valid repo params.
- `Dashboard` falls back on invalid repo params.
- Clicking a repo button results in `router.replace(...)` with preserved params plus updated `owner` / `repo`.
- Repo changes reset stale UI state.
- The selection panel still renders when the available repo list has length 1.

### Unit 5: Integrated verification

**Files**
- Verify touched files from Units 1-4

**Plan**
- Run linting.
- Run the focused page test file.
- Run a production build.
- Fix any integration issues before considering the feature complete.

**Test scenarios**
- `npm run lint` passes.
- `npm test -- src/app/page.test.tsx` passes.
- `npm run build` passes.

## Sequencing

1. Add the page test harness so subsequent behavior tests have a stable base.
2. Add the available-repo source and its small helper logic.
3. Update `src/app/page.tsx` to use resolved repo state, render the panel, and reset repo-specific UI state.
4. Add and stabilize page behavior tests against the new panel and routing logic.
5. Run integrated verification and fix any fallout.

## Risks and Mitigations

- **Risk: available repo data drifts from the working tree.**  
  Mitigation: keep the first version intentionally explicit and aligned to current data; avoid pretending dynamic discovery already exists.

- **Risk: repo selection and existing filter URL sync fight each other.**  
  Mitigation: centralize URL param rewriting in one place and test preservation of existing filter params.

- **Risk: page tests become brittle because of chart rendering and navigation hooks.**  
  Mitigation: stub chart primitives and limit assertions to fetch arguments, panel presence, and router calls.

## Deferred to Implementation

- Whether the available-repo source should remain a static module or move to a generated artifact once multiple data repos exist.
- Exact class-name polish for the selection panel so it fits the current visual system without over-expanding the header area.

## Ready Check

- Requirements are fully mapped to implementation units.
- File paths are repo-relative.
- Test targets are explicit for each feature-bearing unit.
- No product blockers remain; the remaining questions are implementation-level.
