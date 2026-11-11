# JevGrep against CodeGraph on Python and Go/Rust (2026-11-04)

Question: is a code-graph search tool better than JevGrep at finding the code that
answers a natural-language question, alone or as a candidate source for Jev?

## Method

- Questions: the pinned real-task sets, scored on the returned ranges with the same
  localization metrics for every arm ([bench:compare](../../scripts/bench-compare.ts)):
  - Python: `swe-bench-sample-1`, 21 questions on `psf/requests` and `pallets/flask`;
  - Go/Rust: `swe-bench-multilingual-go-rust-1`, 34 questions on `caddyserver/caddy`,
    `gin-gonic/gin`, `tokio-rs/axum` and `sharkdp/bat` (`--go-rust`).
- JevGrep: current `main` (Tree-sitter chunking, `layout-a-nolines-1`), exhaustive
  authorized scan, Jev `jev-1.13.0` through TypeSafe direct, 4,000-token responses.
  The live run captured every fragment's score
  ([Python pool](../pools/codegraph-comparison-2026-11-04-python-scores.json),
  [Go/Rust pool](../pools/codegraph-comparison-2026-11-04-go-rust-scores.json)).
- CodeGraph 1.6.2 (`@colbymchenry/codegraph`, MIT, installed globally, not a package
  dependency): `codegraph query` and `codegraph context` alone, after a cold
  `codegraph init` per snapshot.
- Combinations, replayed on the captured Jev scores at a fixed 16-fragment Jev
  allowance: CodeGraph `context` proposes the candidates (`codegraph-jevgrep`); the
  question's words alone (`e7-hop0`); the question's words plus one CodeGraph
  relation hop (`e7-hop1`). Only proposed fragments can be returned.
- Baselines: `ripgrep` and BM25 over line windows.

R@1 and R@5 are mean per-question evidence recall, not hit rates or the share
of completely answered questions. These historical runs do not separately report
hit rate and complete-evidence success. Python completed 21/21 for every arm.

## Python (21 questions)

| Arm | R@1 | R@5 | MRR | File recall | Time / question | Index (cold, p50) | Jev tokens / question |
|---|---:|---:|---:|---:|---:|---:|---:|
| JevGrep (exhaustive) | 0.690 | 0.851 | 0.802 | 0.944 | 4.6 s | none | 113 k |
| CodeGraph `query` | 0.110 | 0.491 | 0.285 | 0.825 | 1.1 s | 5.5 s | – |
| CodeGraph `context` | 0.286 | 0.455 | 0.389 | 0.706 | 1.3 s | 5.5 s | – |
| CodeGraph `context` → Jev (16 fragments) | 0.719 | 0.779 | 0.786 | 0.825 | – | 5.5 s | 13 k |
| Question words → Jev (16) | 0.719 | 0.779 | 0.786 | 0.825 | – | none | 13 k |
| Question words + 1 graph hop → Jev (16) | 0.791 | 0.875 | 0.905 | 0.897 | – | 5.5 s | 12 k |
| BM25 windows | 0.270 | 0.429 | 0.341 | 0.810 | 0.1 s | 0.1 s | – |
| ripgrep | 0.159 | 0.325 | 0.271 | 0.675 | 0.3 s | none | – |

## Go/Rust (34 planned questions)

| Arm | Completed | Evidence R@5, completed | Evidence R@5, all planned | R@1 | MRR | File recall | Time / question | Index (cold, p50) | Jev tokens / question |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| JevGrep (exhaustive) | 32/34 | 0.687 | 0.646 | 0.573 | 0.690 | 0.906 | 3.6 s | none | 125 k |
| CodeGraph `query` | 34/34 | 0.319 | 0.319 | 0.088 | 0.165 | 0.603 | 1.0 s | 4.1 s | – |
| CodeGraph `context` | 34/34 | 0.265 | 0.265 | 0.118 | 0.164 | 0.529 | 1.3 s | 4.1 s | – |
| CodeGraph `context` → Jev (16 fragments) | 32/34 | 0.482 | 0.453 | 0.435 | 0.510 | 0.719 | – | 4.1 s | 14 k |
| Question words → Jev (16) | 32/34 | 0.521 | 0.490 | 0.466 | 0.542 | 0.734 | – | none | 14 k |
| Question words + 1 graph hop → Jev (16) | 32/34 | 0.495 | 0.466 | 0.417 | 0.521 | 0.734 | – | 4.1 s | 13 k |
| BM25 windows | 34/34 | 0.338 | 0.338 | 0.191 | 0.236 | 0.765 | 0.04 s | 0.04 s | – |
| ripgrep | 34/34 | 0.244 | 0.244 | 0.118 | 0.181 | 0.618 | 0.3 s | none | – |

JevGrep completed 32/34 (94.1%); two searches hit a cap. Replayed combination
arms inherit those gaps and also completed 32/34. Standalone CodeGraph, BM25 and
ripgrep completed all 34. The all-planned column is the raw report's
`recallAt5OverPlanned`, rounded to three decimals, with incomplete questions scored
zero. It is not reconstructed from rounded completed-search numbers.
Raw reports: [live Jev](codegraph-comparison-2026-11-04-gorust-jevgrep.json),
[replays](codegraph-comparison-2026-11-04-gorust-replay.json), and
[standalone tools](codegraph-comparison-2026-11-04-gorust-tools.json).

## Reading

- CodeGraph alone has lower mean evidence recall than JevGrep in these runs; completion and the all-planned denominator are shown above.
- As a candidate source for Jev, CodeGraph `context` adds nothing over the question's
  own words (Python) or does worse (Go/Rust).
- One relationship hop helps on Python and hurts on Go/Rust, the same unstable sign
  as the [2026-11-03 E7 study](2026-11-03-graph-expansion.md). CodeGraph resolves
  fewer edges than it leaves unresolved on these snapshots (for example 582 edges
  against 1,169 unresolved references on one `requests` snapshot).
- No CodeGraph integration is adopted. JevGrep needs no index; its exhaustive scan
  costs about 9 times the Jev tokens of a 16-fragment allowance.

## Limits

One live run per dataset; combinations reuse its captured Jev scores. 55 questions
on six repositories.

Spend: about $0.25 on TypeSafe.
