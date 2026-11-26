# ADR: Runs attempt chart and window aggregates

## Context
Runs windows may contain tens of thousands of attempts. Sending all attempts to the browser is expensive, while page-local statistics misrepresent the selected window.

## Decision
Use one inclusive UTC date window for chart, table, and cards. A first attempt uses its creation timestamp, falling back to parent creation and then its recorded start. A rerun uses its recorded start for window placement only; it is not the rerun request time. Attempts without a usable window timestamp are excluded. Legacy rerun trigger-to-start values are not shown.

Fetch every tracked attempt in that window independently of table pagination. Give each attempt its own fixed-width slot in a horizontally scrollable chart, rendering only visible slots plus overscan. Distinguish a true zero duration from a missing or invalid duration. Compute average, P50 and P90 in SQL over successful tracked attempts with non-negative runtimes in the entire filtered window; success rate uses terminal attempts. Missing timings are excluded. Runs defaults to `vllm-project/vllm-ascend` when repo is absent; `repo=all` explicitly requests all repositories.

## Trade-offs and consequences
Database and payload work grow with the complete window; there is deliberately no sampling or truncation. Virtualization bounds the rendered marks without collapsing distinct attempts into the same slot. The chart and aggregates remain independent of pagination. Other tabs retain their existing default. Future changes to timing eligibility must keep all three duration aggregates aligned and update the UI explanation.
