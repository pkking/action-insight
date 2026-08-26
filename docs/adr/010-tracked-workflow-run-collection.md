# ADR-010: Collect tracked workflow runs at the GitHub API boundary

## Status

Accepted

## Context

The collector configured jobs and steps only for tracked workflows, but enumerated every repository workflow run through the repository-wide Actions runs endpoint first. High-volume repositories such as sglang saturated the endpoint's 1,000-result cap, forcing recursive time-window splitting over unrelated workflows and preventing timely collection of the workflows used by CI reports.

## Decision

When `etl/repos.yaml` configures workflow files for a repository, resolve their GitHub workflow IDs through the Actions workflows endpoint, then list runs through each workflow-specific runs endpoint. Continue using repository-wide run listing only for repositories without workflow rules. A configured workflow that cannot be resolved fails collection rather than silently widening to all runs.

## Consequences

Raw `runs`, `jobs`, and `steps` collected for configured repositories are limited to tracked workflows. This matches CI efficiency and drilldown report scope and avoids unrelated-run API pagination. Workflow-file configuration becomes a required collection contract; renamed or deleted files must be corrected in `etl/repos.yaml` before collection can resume.
