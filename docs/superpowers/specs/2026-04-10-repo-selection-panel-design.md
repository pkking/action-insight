# Repo Selection Panel Design

## Goal

Add a repository selection panel to the dashboard so users can switch the action details view between repositories that already have collected data without leaving the page.

## Current Context

- The dashboard is implemented in `src/app/page.tsx` as a client component with URL-backed filter state.
- Data loading already supports arbitrary `owner` and `repo` values through `src/lib/data-fetcher.ts`, but the page currently hardcodes `vllm-project/vllm-ascend`.
- The ETL tracking list exists in `etl/repos.yaml`, but the frontend cannot assume every tracked repo already has data under `data/<owner>/<repo>/`.
- The current worktree data only shows `data/vllm-project/vllm-ascend/`, so "tracked repo" and "repo with available data" are not equivalent today.

## Requirements

1. Show a selection panel sourced from repositories that currently have data in `data/`.
2. Limit choices to repositories with an existing `data/<owner>/<repo>/index.json`.
3. Switching repositories should refresh the same dashboard views, charts, stats, and run details for the chosen repository.
4. The active repository should be reflected in the URL so the current view can be shared.
5. Existing loading, empty, and error states must continue to work and should reflect the selected repository.
6. Changing repositories should clear stale detail UI state such as expanded rows and chart zoom.
7. The selection panel should still render when only one repository is available so the current repo remains visible in the UI.

## Approach

### Option A: Compact dropdown in the existing controls row

- Keeps the page layout nearly unchanged.
- Minimizes layout work.
- Makes repo switching less visible than the user requested “selection panel”.

### Option B: Dedicated panel listing tracked repositories

- Matches the requested interaction model.
- Keeps switching explicit and fast for a small tracked repo set.
- Adds a small amount of layout work near the header.

### Option C: Freeform `owner/repo` input

- More flexible, but explicitly out of scope because the user only wants tracked repos from `repos.yaml`.
- Adds validation and error cases that do not serve the request.

## Decision

Implement Option B.

Add a dedicated repository selection panel near the top of the dashboard. Each repository with available data will render as a selectable button. The page will read and write `owner` and `repo` search params and use them as the fetch key for dashboard data.

## Data Model

Expose a frontend-friendly list of repositories with available data:

- `owner`
- `repo`
- `slug` as `owner/repo`
- `label` for display

This list should be derived from the set of repo directories that already have collected data rather than mirroring `etl/repos.yaml` into a second manually maintained frontend config. The ETL file remains the operational source for collection, but the UI should only offer repos that are actually readable by the dashboard.

## UI Design

Add a panel card above the date-range controls:

- Title: `Tracked Repositories`
- Body: one button per available repo
- Active state: blue-accented background/border
- Inactive state: neutral surface with hover affordance
- Dark mode: use matching `dark:` styles
- Single repo: still show the panel with the single selected repo button

The panel should remain compact on desktop and stack naturally on small screens.

## State and Routing

Use URL search params:

- `owner`
- `repo`

Behavior:

- If params are absent, default to the first available repo.
- If params do not match a repo with available data, fall back to the first available repo.
- Repo changes should preserve existing date/filter/sort params when practical.
- Repo changes should reset:
  - expanded run row
  - chart zoom selection
  - in-memory runs list before the new fetch resolves

## Fetching

Replace the current hardcoded repository in the page fetch effect with the selected `owner/repo`.

The existing fetcher API already supports this, so no protocol change is needed. The selected repo simply becomes part of the fetch effect dependencies.

## Empty/Error/Loading Handling

- Loading state remains as-is.
- Empty states should mention the selected repo when useful.
- Errors should mention the selected repo so failures are easier to interpret.
- No-data repos should not appear as selectable options in this first iteration.

## Testing

Use TDD for the selection behavior.

Focus on:

- default repo selection when URL params are absent
- URL param selection for a valid available repo
- invalid URL params falling back to the default available repo
- switching repos updates the active panel state and fetch target
- repo switches clear stale expanded/zoom UI state
- single available repo still renders the selection panel

## Files Expected To Change

- Modify: `src/app/page.tsx`
- Create or modify: repo availability source used by the page
- Create or modify tests for repo selection behavior, depending on current test setup

## Non-Goals

- Editing tracked repositories from the UI
- Supporting arbitrary manual repository input
- Showing tracked repos that do not yet have readable data
- Refactoring the dashboard into multiple pages
