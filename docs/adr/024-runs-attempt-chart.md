# ADR: Runs attempt chart and window aggregates

## Context
Runs windows may contain tens of thousands of attempts. Sending all attempts to the browser is expensive, while page-local statistics misrepresent the selected window.

## Decision
Render attempt runtime bars from the same SQL-paginated rows as the table. Compute average, P50 and P90 in SQL over successful tracked attempts with non-negative runtimes in the entire filtered window; success rate uses terminal attempts. Missing timings are excluded. Runs defaults to vllm-project/vllm-ascend when repo is absent; `repo=all` explicitly requests all repositories.

## Trade-offs and consequences
The chart shows one page at a time rather than the entire distribution; users navigate pages to reach every attempt. Aggregates remain independent of pagination. Other tabs retain their existing default. Future changes to timing eligibility must keep all three duration aggregates aligned and update the UI explanation.
