# Relationship expansion (E7) — negative result — 2026-11-03

Roadmap section 13, Stage A: does a code graph that proposes related candidates help
JevGrep when Jev evaluates them under the same allowance? Answer on this dataset:
**no robust gain**. Stage B (an optional graph connector) was not started.

## Setup

- Dataset: `swe-bench-sample-1` (12 tasks, 21 questions; `psf/requests` dev and
  `pallets/flask` held-out), scored on the delivered excerpts with the same
  localization metrics as every other `bench:compare` arm.
- Graph tool: CodeGraph 1.6.2 (`@colbymchenry/codegraph`, installed globally, not a
  package dependency), read-only through its SQLite index. Followed relations:
  `calls`, `instantiates`, `extends`, `references`, `imports`; `contains` is ignored.
- Jev: `typesafe-ai/jev` via Vercel AI Gateway. One live exhaustive capture wrote
  every fragment's score to [the score pool](../pools/e7-swe-bench-sample-1-scores.json)
  (hashes, ranges, scores and token counts; no source or question text).
- Replay: candidate arms run the ordinary engine on the same snapshot; fragments
  outside the candidate set get score 0, so only candidates can be returned, and Jev
  cost is the candidate set alone. `jevgrep-replay` (no mask) reproduces the live run
  exactly on all 21 questions (R@1 0.738, R@5 0.851, MRR 0.833, file recall 0.944).
  This relies on Jev judging each fragment independently of its batch neighbors.
- Arms, all with the same fixed BM25 ranking over JevGrep fragments and the same
  fragment allowance (`--budget`):
  - `e7-hop0`: the top `budget` lexical fragments (no expansion);
  - `e7-hop1` / `e7-hop2`: the top `seeds` lexical fragments, then one or two
    relation hops (`fanout` 4 neighbors per symbol and hop, interleaved across seeds,
    visited symbols deduplicated, cycles terminated), then lexical fill;
  - `e7-adjacent`: locality control, same seeds, then the ±1/±2 fragments in the
    seed's own file, no relationship data;
  - `codegraph-jevgrep`: CodeGraph's own `context` retrieval proposes candidates,
    lexical fill.

Raw summaries, paired comparisons and per-question Recall@5 for every run are in
[e7-graph-expansion-2026-11-03.json](e7-graph-expansion-2026-11-03.json).

## Tools alone (21 questions, all complete)

| Arm | R@1 | R@5 | MRR | File recall | Lines in top 5 | Latency p50 | Index (cold, p50) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ripgrep | 0.159 | 0.302 | 0.269 | 0.698 | 194 | 218 ms | none |
| BM25 windows | 0.270 | 0.429 | 0.341 | 0.810 | 197 | 26 ms | 38 ms |
| codegraph-query | 0.110 | 0.491 | 0.285 | 0.825 | 202 | 654 ms | 2.34 s |
| codegraph-context | 0.286 | 0.455 | 0.389 | 0.706 | 298 | 747 ms | 2.34 s |
| JevGrep, live exhaustive | 0.738 | 0.851 | 0.833 | 0.944 | 304 | 3.76 s (p95 8.16 s) | none |

Live JevGrep used 118 requests and 2,374,696 reported input tokens (113k per
question, about $0.0047 per question at $0.042 per million input tokens).

## E7 at budget 16, seeds 8

| Arm | R@1 | R@5 | MRR | File recall | Candidate recall | Jev input tokens / question | Jev $ (21 questions) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exhaustive (`jevgrep-replay`) | 0.738 | 0.851 | 0.833 | 0.944 | 1.000 | 115,460 | 0.102 |
| no expansion (`e7-hop0`) | 0.729 | 0.782 | 0.786 | 0.825 | 0.806 | 13,222 | 0.012 |
| locality control | 0.682 | 0.729 | 0.738 | 0.825 | 0.729 | 12,631 | 0.011 |
| one hop | 0.801 | 0.853 | 0.881 | 0.873 | 0.877 | 12,654 | 0.011 |
| two bounded hops | 0.801 | 0.853 | 0.881 | 0.873 | 0.877 | 12,645 | 0.011 |
| CodeGraph context → Jev | 0.729 | 0.782 | 0.786 | 0.825 | 0.806 | 12,968 | 0.011 |

Candidate recall is the share of required evidence inside the evaluated candidates,
an upper bound on what Jev can return. Provider time modeled from the live capture
is 7.4 s per question sequentially for the exhaustive scan and 1.3 s for every
16-fragment arm. Relationship lookup adds 3–4 ms per question once the index is
loaded; a CodeGraph `context` call adds 1.75 s (p50).

## Is the one-hop gain real?

Paired per-question difference of one hop minus no expansion, 95% bootstrap interval
resampled by task, with the number of questions that improved / regressed:

| Budget / seeds | ΔR@5 | Interval | Better / worse | ΔR@1 |
| --- | ---: | --- | ---: | ---: |
| 8 / 4 | −0.043 | [−0.143, 0.014] | 1 / 1 | −0.048 |
| 16 / 4 | −0.024 | [−0.143, 0.068] | 1 / 1 | −0.048 |
| 16 / 8 | +0.071 | [0.000, 0.184] | 2 / 0 | +0.071 |
| 16 / 12 | +0.021 | [−0.007, 0.079] | 1 / 1 | −0.003 |
| 32 / 16 | +0.026 | [0.000, 0.084] | 2 / 0 | +0.074 |
| 16 / 8, graph 100 commits stale | +0.066 | [−0.010, 0.182] | 2 / 1 | 0.000 |

Two hops never improved on one hop in any configuration: the allowance is spent by
the first hop, and with a smaller first hop (seeds 4) the second hop only lowered
file recall (0.825 vs 0.873).

Conclusion:

- The best setting rests on two questions (`psf__requests-1768:change`,
  `pallets__flask-4045:change`); every interval touches zero, and the sign flips at
  budget 8 and at 4 seeds. This is not a real gain.
- The locality control is never better than no expansion, so the two wins do come
  from relations, but relations are too sparse to help reliably: CodeGraph resolves
  843 edges per `requests` snapshot against 1,216 unresolved references (flask:
  2,106 against 3,120). Dynamic dispatch, aliases and re-exports in these Python
  projects are mostly missing edges, and a missing edge proves nothing.
- CodeGraph's own context retrieval proposes nothing that the lexical ranking did not
  already contain at 16 fragments on a fresh index.
- The larger lever is the candidate allowance, not relationships: no expansion at
  32 fragments reaches R@5 0.827 at 23% of the exhaustive Jev tokens, with no graph.
  The exhaustive authorized scan remains the reference.

## Index costs

| Repository | Cold `codegraph init` (p50) | `codegraph sync` after one-file edit (p50) | Index size (p50) | Nodes / followed edges |
| --- | ---: | ---: | ---: | ---: |
| psf/requests (8 snapshots) | 2.3–2.6 s | 0.54 s | 1.8 MB | 628 / 843 |
| pallets/flask (4 snapshots) | 3.7 s | 0.97 s | 5.1 MB | 2,378 / 2,106 |

Cold times come from a single uncontended run (2.34 s p50 over all 12 snapshots)
and from the sweep, where six runs shared the machine. Warm reuse is the SQLite read
(a few milliseconds per question after one load per snapshot). JevGrep itself needs
no index.

## Limits

21 questions on two Python repositories, one graph tool, one Jev capture. Laya was
not available on this machine. The result says relationship expansion is not worth a
connector here; it does not rule it out for statically typed, call-heavy code. To
re-run without provider spend:

```sh
npm run bench:compare -- --arms jevgrep-replay,e7-hop0,e7-adjacent,e7-hop1,e7-hop2,codegraph-jevgrep \
  --replay benchmarks/pools/e7-swe-bench-sample-1-scores.json --budget 16 --seeds 8
```

Total live spend for this experiment: two identical exhaustive captures (the first
was discarded after a harness fix), 236 requests and 4,749,392 reported input
tokens, about $0.20.
