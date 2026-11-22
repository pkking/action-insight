# ADR: Runs attempt chart and window aggregates

## Context
Runs windows may contain tens of thousands of attempts. Sending all attempts to the browser is expensive, while page-local statistics misrepresent the selected window.

## Decision
Fetch every tracked attempt in the selected window independently of table pagination, using a compact read-model DTO. Render batched SVG paths by outcome, not a React node per attempt; missing or invalid durations use a separate baseline marker. Compute average, P50 and P90 in SQL over successful tracked attempts with non-negative runtimes in the entire filtered window; success rate uses terminal attempts. Missing timings are excluded. Runs defaults to vllm-project/vllm-ascend when repo is absent; `repo=all` explicitly requests all repositories.

## Trade-offs and consequences
The complete window increases database, payload and browser work with window size; there is deliberately no sampling or truncation. Dense marks can overlap. The chart and aggregates remain independent of pagination. Other tabs retain their existing default. Future changes to timing eligibility must keep all three duration aggregates aligned and update the UI explanation.
