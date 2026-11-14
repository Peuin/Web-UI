# Performance baseline — Web-UI folder loading

How to measure, and the numbers to record before/after each perf change.
`drive-list-folder` and `final-files` return a `Server-Timing` header with
`auth;db;sign;total` durations — read it in DevTools → Network → the request.

## Setup

- Sign in on Chrome desktop, open DevTools → Network, check "Preserve log".
- Pick 3 folders: small (~10 items), medium (~100), large (~500).
- For Final Output, repeat in the Final Output tab (same folder sizes if possible).
- Disable browser cache for cold numbers; keep it enabled for the "reopen" rows.

## Metrics to record

| Metric | Where |
|---|---|
| TTFB | Network → Timing → Waiting (TTFB) |
| auth / db / sign | `Server-Timing` response header |
| Response size | Network → Size (transferred, not decoded) |
| Images visible | Stopwatch/LCP — time until all thumbnails painted |
| Image cache | reopen same folder → `(disk cache)`/`(memory cache)` in Size column |
| INP | Performance panel → record while typing in Product Description and clicking cards |

## Baseline table (fill in)

| Folder | Tab | TTFB | auth | db | sign | Size | Images visible | Notes |
|---|---|---|---|---|---|---|---|---|
| small (~10) | Drive | | | | | | | |
| small (~10) | Final | | | | | | | |
| medium (~100) | Drive | | | | | | | |
| medium (~100) | Final | | | | | | | |
| large (~500) | Drive | | | | | | | |
| large (~500) | Final | | | | | | | |

| Interaction | INP |
|---|---|
| Typing in Product Description | |
| Click-selecting a card | |

| Reopen behaviour | Value |
|---|---|
| Back/breadcrumb to a seen folder — time to list | target < 100 ms, no skeleton |
| % thumbnails from cache on reopen | target ≥ 90% |

## After each change

Re-run the same folders and copy the numbers next to the baseline. A change is
"done" when its target in the plan is met (see plan §0 "Mục tiêu đo được").
