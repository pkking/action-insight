# Repo Selection Panel Design

## Goal

Add a repository selection panel to the dashboard so users can switch the action details view between tracked repositories without leaving the page.

## Current Context

- The dashboard is implemented in [`/home/lcr/action-insight/src/app/page.tsx`](/home/lcr/action-insight/src/app/page.tsx) as a client component with URL-backed filter state.
- Data loading already supports arbitrary `owner` and `repo` values through [`/home/lcr/action-insight/src/lib/data-fetcher.ts`](/home/lcr/action-insight/src/lib/data-fetcher.ts), but the page currently hardcodes `vllm-project/vllm-ascend`.
- The tracked repository list currently exists only in [`/home/lcr/action-insight/etl/repos.yaml`](/home/lcr/action-insight/etl/repos.yaml).

## Requirements

1. Show a selection panel sourced from the tracked repositories list.
2. Limit choices to repositories already listed in `etl/repos.yaml`.
3. Switching repositories should refresh the same dashboard views, charts, stats, and run details for the chosen repository.
4. The active repository should be reflected in the URL so the current view can be shared.
5. Existing loading, empty, and error states must continue to work and should reflect the selected repository.
6. Changing repositories should clear stale detail UI state such as expanded rows and chart zoom.

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

Add a dedicated repository selection panel near the top of the dashboard. Each tracked repository will render as a selectable button. The page will read and write `owner` and `repo` search params and use them as the fetch key for dashboard data.

## Data Model

Add a small typed frontend config module that exports the tracked repositories:

- `owner`
- `repo`
- `slug` as `owner/repo`
- `label` for display

This module will mirror the contents of `etl/repos.yaml` for frontend bundling. The ETL file remains the operational source for collection, but the UI uses a static typed list that can be imported directly into the client bundle.

## UI Design

Add a panel card above the date-range controls:

- Title: `Tracked Repositories`
- Body: one button per tracked repo
- Active state: blue-accented background/border
- Inactive state: neutral surface with hover affordance
- Dark mode: use matching `dark:` styles

The panel should remain compact on desktop and stack naturally on small screens.

## State and Routing

Use URL search params:

- `owner`
- `repo`

Behavior:

- If params are absent, default to the first configured tracked repo.
- If params do not match a tracked repo, fall back to the first tracked repo.
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

## Testing

Use TDD for the selection behavior.

Focus on:

- default repo selection when URL params are absent
- URL param selection for a valid tracked repo
- invalid URL params falling back to the default tracked repo
- switching repos updates the active panel state and fetch target
- repo switches clear stale expanded/zoom UI state

## Files Expected To Change

- Modify: `/home/lcr/action-insight/src/app/page.tsx`
- Create: `/home/lcr/action-insight/src/lib/tracked-repos.ts`
- Create or modify tests for repo selection behavior, depending on current test setup

## Non-Goals

- Editing tracked repositories from the UI
- Supporting arbitrary manual repository input
- Refactoring the dashboard into multiple pages
