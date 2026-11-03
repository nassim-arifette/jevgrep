# Compact Jev payloads, 2026-11-03

Roadmap section 11: the current request layout, which repeats the relevance
criterion in every question, against shorter, explicitly versioned layouts.
Raw report: [layouts-2026-11-03.json](layouts-2026-11-03.json). Judgments:
[layout-a-1](layout-judgments-2026-11-03-layout-a-1.json),
[layout-compact-state-1](layout-judgments-2026-11-03-layout-compact-state-1.json),
[layout-compact-ref-1](layout-judgments-2026-11-03-layout-compact-ref-1.json).
Pools: the three E2 pools plus [false-premise-1](../pools/false-premise-1.json).

## Layouts

All three keep the search question, the full criterion, its version and the layout
version in shared state, and one question per excerpt with the same
`File`/`Lines`/`Structure` header and source text. Only the per-question criteria
differ:

| Layout | Per-question criteria |
|---|---|
| `layout-a-1` (default) | the full relevance criterion, repeated in every question |
| `layout-compact-state-1` | none; the criterion is only in state |
| `layout-compact-ref-1` | a short pointer: "The excerpt meets the criterion given in state." (OpenRouter also gets the matching `false` pointer) |

The corpus stays out of shared state. Each layout writes its own version into the
request state; a batch without the experimental `layout` field serializes to the
exact bytes it did before (pinned by SHA-256 in `tests/request-layout.test.ts` for
the direct, Gateway and OpenRouter transports, with and without a judgment criterion).

## Setup

- All 5,009 captured candidates of 65 searches (30 synthetic, 15 `psf/requests`
  dev, 6 `pallets/flask` held-out, 14 false-premise) were judged again live under
  each layout, through `vercel-ai-gateway` / `typesafe-ai/jev`, on the same
  deterministic chunks (packed under the layout-A envelope, the largest): 198
  requests per layout, every question in one request independent of the others.
- `analyze` replays the default selection (threshold 0.5, 4,000-token response
  budget) offline with each layout's scores. The layout-A rerun is the reference;
  the captured pool scores are a second layout-A sample and give the noise floor.
- Adoption rule, set before the run: a compact layout must cut reported input
  tokens by at least 20 % (specification section 9) and stay within the layout-A
  noise floor on coverage, counterevidence coverage, negative behavior and score
  agreement on every group.

## Cost and latency

| Layout | Requests | Reported input tokens | Tokens / candidate | Bytes / candidate | Request p50 | Request p95 |
|---|---:|---:|---:|---:|---:|---:|
| `layout-a-1` | 198 | 3,247,050 | 648.2 | 2,712 | 405 ms | 5,673 ms |
| `layout-compact-state-1` | 198 | 2,856,744 (−12.0 %) | 570.3 | 2,297 | 363 ms | 6,921 ms |
| `layout-compact-ref-1` | 198 | 2,956,924 (−8.9 %) | 590.3 | 2,367 | 349 ms | 4,581 ms |

No request failed or returned an invalid answer. Latency is dominated by provider
variance (p95 moves in both directions); one run per layout cannot separate it.

## Quality and agreement

Positive searches: R@1, R@5, MRR and coverage of required evidence. False-premise
searches: coverage of the counterevidence. Negatives: share of synthetic
no-answer searches that return nothing. Agreement against the layout-A rerun:
mean absolute score difference, candidates crossing the 0.5 threshold and searches
whose replayed result changed.

| Arm | R@1 | R@5 | MRR | Coverage | Counterevidence | Negatives | Mean \|Δ\| | Crossings | Changed searches |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| captured `layout-a-1` | 0.759 | 0.916 | 0.911 | 0.916 | 1.000 | 1.000 | 0.0085 | 28 | 7 |
| `layout-a-1` rerun | 0.759 | 0.916 | 0.911 | 0.916 | 1.000 | 1.000 | 0 | 0 | 0 |
| `layout-compact-state-1` | 0.804 | 0.922 | 0.941 | 0.922 | 0.679 | 1.000 | 0.0340 | 117 | 21 |
| `layout-compact-ref-1` | 0.804 | 0.916 | 0.930 | 0.916 | 0.929 | 1.000 | 0.0302 | 77 | 12 |

By group (R@5 for positive groups, counterevidence coverage for false premises):

| Arm | Synthetic | requests dev | flask held-out | False premise |
|---|---:|---:|---:|---:|
| captured `layout-a-1` | 0.972 | 0.867 | 0.811 | 1.000 |
| `layout-a-1` rerun | 0.972 | 0.867 | 0.811 | 1.000 |
| `layout-compact-state-1` | 0.972 | 0.900 | 0.776 | 0.679 |
| `layout-compact-ref-1` | 0.972 | 0.867 | 0.811 | 0.929 |

## Result: keep `layout-a-1`

- The saving is 9–12 % of input tokens, below the 20 % adoption gate; the
  repeated criterion is about 80 tokens of a ~650-token question, and the source
  excerpt dominates.
- Removing the per-question criterion changes what Jev judges, not only how much it
  reads: scores move four times as much as two layout-A samples differ from each
  other (mean |Δ| 0.034 vs 0.0085, 117 vs 28 threshold crossings).
- The change is not neutral on the hard cases. `layout-compact-state-1` loses
  counterevidence on false-premise questions (1.000 → 0.679) and R@5 on the
  held-out repository (0.811 → 0.776). The pointer layout limits the damage but
  still loses one false-premise search (0.929) and doubles the score crossings.
- R@1 and MRR rise on synthetic and requests-dev searches under both compact
  layouts, but on single runs inside a larger score drift and with the
  counterevidence regression, this is not evidence for adoption.
- Production layout, criterion and cache identities are unchanged. The layouts stay
  available as an experimental `EvaluationBatch.layout` field for later runs (for
  example with a pinned direct model or larger shared-state wording changes).

Live spend: 594 requests, 9,060,718 reported input tokens, about $0.38 at
$0.042 per million. `analyze` makes no request.
