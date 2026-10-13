# ADR-017: Unified CI repository and workflow configuration

## Status

Accepted

## Context

Tracked repositories and workflow files were declared in `etl/repos.yaml`, while reporting names, comparison groups, resource requirements, and workflow selection were separately maintained in `.github-ci-efficiency.yaml`. This duplication allowed a workflow to be collected but omitted from reports (for example, LlamaFactory's CPU `tests.yml`). It also required tests and maintenance to reconcile two inventories.

## Decision

Use `etl/repos.yaml` as the single source of truth for repository and workflow inventory. Existing `file` entries remain the stable collection identity. Optional `report_name`, `comparison_name`, `static_resources`, and repository-level `comparison_group` fields carry reporting metadata. Only workflows with `report_name` appear in default efficiency reports; all configured workflows remain eligible for collection. Report defaults and `resource_pools` also live in this file.

The efficiency report reads this unified schema directly. `config/drilldown-workflows.yaml` remains separate because it is a deliberate restricted report allowlist, not a second inventory. The old `.github-ci-efficiency.yaml` is removed after migration.

## Consequences and trade-offs

- Collectors continue to use only `repo` and `workflows[].file` (plus existing matching/threshold options); reporting metadata does not alter collection selection.
- Adding an inventory workflow does not implicitly broaden standard reports. Set `report_name` to include it.
- Workflow filenames remain the durable matching key; `report_name` is the stable presentation label for dynamic GitHub run names.
- Resource and comparison metadata are maintained beside the corresponding workflow, eliminating cross-file drift.
- New Omni and SpeCo workflows are collection-only until explicitly assigned reporting names. The verl report/drilldown selection moves to the current VeOmni PPO workflows; the previous verl selectors remain in the collection inventory but are not default report targets.
- The report parser temporarily accepts the older `repositories` shape for isolated compatibility tests, but runtime defaults use `etl/repos.yaml` only.

## Follow-up constraints

When adding a workflow for collection and reporting, add it once under the repository in `etl/repos.yaml`, set its stable filename, and add report metadata if it belongs in standard reports. Update `static_resources` when workflow runner topology changes. Keep the drilldown allowlist intentionally narrower where required.
