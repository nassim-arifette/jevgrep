# Correctness and reliability measurements (2026-11-11)

## Frozen inputs

The implementation and harness were measured at `fcb738119805e81328b194b8f6b1f1c6d3b72821`,
against the reviewed baseline `4e9aab455ed6d20223fbe66789b316a13ef97a46`.
Both ran on Apple M4 Pro, macOS arm64, Node.js v24.22.2.
The final measurement checkout was clean. Source, harness and lockfile hashes are
embedded in each raw report; the runner rejects drift during measurement.

These are offline execution measurements. Fixed scores of 0.8 exercise real
inventory, preparation, tokenization, persistence, selection and rendering. There
are no paid model calls and no new model-quality conclusions. A represented
fragment here means synthetic evidence delivered, rather than an annotated answer.

## Before and after on the same local workload

Five fresh subprocess samples per revision, 64 generated TypeScript/Python/SQL
files, one evaluation job, 4,000 response tokens. Searches within each sample share
one engine and its caches. OS caches and other host activity are uncontrolled;
imports and fixture setup are excluded from timings. Runs were sequential, rather
than randomized pairs. Five observations do not support p95 or uncertainty claims.

| Scenario | Baseline median ms | Current median ms | Current provider attempts |
|---|---:|---:|---:|
| `cold` | 212.5 | 215.4 | 1 |
| `repeat_question` | 43.2 | 41.4 | 0 |
| `new_question` | 119.9 | 126.5 | 1 |
| `small_edit` | 49.1 | 50.5 | 1 |

The current search represents **9 fragments instead of 8** in every scenario,
within the same 4,000-token limit and with identical provider attempts and transmitted
bytes. Warm cache lookup alone falls from 10.49 to 2.51 ms.
Overall warm latency is similar; new-question and edited-file medians are slightly
higher. These small runs do not establish a general end-to-end speedup.

An initial refill implementation retokenized the same candidate ranges in each
round, increasing selection time. A search-local memo now bounds exact excerpt
cost reuse to 4 MiB / 4,096 ranges. Unchanged selections skip another full render.
The final figures above include that correction; exact output budgets, freshness,
continuations and replay parity remain checked by tests.

Raw data: [baseline](2026-11-11/baseline-local.json),
[current](2026-11-11/current-local.json).

## Current 13-scenario matrix

Twenty independent fresh subprocess samples. This matrix adds a two-function
movement fixture to the 64-file workload, so its absolute timings should not be
compared with the smaller local workload above. The runner records the generated
workload hash and scenario setup semantics in the [raw matrix](2026-11-11/matrix.json).

| Scenario | p50 ms | p95 ms | Attempts | Represented fragments | Score payload reads | Complete |
|---|---:|---:|---:|---:|---:|---:|
| `cold` | 224.12 | 242.32 | 2 | 9 | 66 | 100% |
| `identical_query` | 42.12 | 45.81 | 0 | 9 | 1 | 100% |
| `new_query` | 131.05 | 139.57 | 2 | 9 | 66 | 100% |
| `edited_file` | 50.21 | 53.54 | 1 | 9 | 14 | 100% |
| `shifted_function` | 18.17 | 19.68 | 1 | 3 | 1 | 100% |
| `continuation` | 32.15 | 35.06 | 1 | 17 | 6 | 100% |
| `multiquestion` | 161.34 | 176.84 | 2 | 18 | 67 | 100% |
| `deadline_preparation` | 4.94 | 5.56 | 0 | 0 | 0 | 0% |
| `deadline_planning` | 8.62 | 9.26 | 0 | 0 | 1 | 0% |
| `deadline_evaluation` | 15.61 | 16.95 | 1 | 0 | 8 | 0% |
| `deadline_selection` | 27.62 | 30.99 | 1 | 8 | 8 | 0% |
| `cancellation` | 13.42 | 14.72 | 0 | 0 | 0 | 0% |
| `mcp_ping` | 55.23 | 63.38 | 0 | 19 | 0 | 100% |

The four deadline scenarios intentionally return partial coverage. They inject a
manual deadline during preparation, planning, evaluation or selection; wall times
measure the work needed to return, rather than a ten-millisecond timing guarantee.
Cancellation intentionally returns `CANCELLED`, so zero completion is expected in
that row. Every normal scenario completes in every sample.

The identical query reuses 66 scores, 65 directly from resident entries and one
through a payload read after shard invalidation. It makes no provider attempt.
The shifted function scenario reuses both unchanged functions and evaluates only
the added function. Continuation reuses 64 scores and evaluates only the six
remaining fragments. Multiquestion uses one shared preparation while accounting
for both questions' evaluation work.

MCP ping delivery during warm cache lookup has p50 1.14 ms / p95 1.28 ms.
Cancellation delivery has p50 1.12 ms / p95 1.20 ms; return after delivery has
p50 0.15 ms / p95 0.19 ms. These are local event-loop/stdio probes on this workload,
not client-wide or network latency promises.

Sampled RSS medians range from approximately 240 to 248 MiB across the sequential
scenarios, including tokenizer and parser state. They are samples at instrumented
boundaries, not guaranteed peaks or memory ceilings. The cache controls separately
bound approximate preparation residency to 64 MiB, dirty entries to 16 MiB and
resident scores to 16 MiB. Payload groups are bounded to 4 MiB plus one final body;
retained batch-cost bodies have a separate 16 MiB limit. Snapshots and other process
allocations are outside these cache limits. Weighted eviction, oversized entries,
write failures, TTL changes and concurrent cache clears have deterministic tests.

## Reproduce

```sh
npm ci
npm run verify
npm run bench -- --files 64 --samples 5 --output benchmark-results/local.json
npm run bench:matrix -- --files 64 --samples 20 --output benchmark-results/matrix.json
```

Use Node.js 24 and a stable checkout. The child processes block external network
entry points. Complete profiles include tokenizer input, provider attempts,
transmitted bytes, evidence counters, memory samples and completion. The matrix
also records score payload reads, resident hits, timer delay and interruption
latency. Returned-token budgets and source hashes are included beside timings.

## Verification

The final Node.js 24 verification passes formatting, lint, TypeScript, 638 tests
(634 passed, four platform/filesystem skips), the production build and all eight
CLI smoke checks. Installed-package tests build through the production path and
search TypeScript, Go, Rust and worker-sized fixtures without network access.

## Remaining evaluation work

The historical provider-quality comparisons have not been rerun for these changes.
Larger negative/false-premise sets, repeated paired live runs with uncertainty,
matched returned-context budgets and end-to-end agent outcomes remain future
studies. No new provider integration or persistent cache format was introduced.
