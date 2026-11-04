# Jev against OpenAI judges inside JevGrep (2026-11-04)

Question: if JevGrep kept its pipeline (authorization, chunking, batching, selection
under a token budget) but asked another model to judge each fragment, would results
improve? Only the judge changes; everything else is identical.

## Method

- Cases: the 65 searches and 5,009 captured candidates of the E2/E8 pools: 24
  synthetic positive and 6 synthetic no-answer searches, 15 `psf/requests` dev and 6
  `pallets/flask` held-out SWE-bench questions, and 14 false-premise questions whose
  correct answer is the code that contradicts the premise.
- Every candidate is judged on the same deterministic chunks (packed under the Jev
  envelope) with the production model-visible excerpt: `layout-a-nolines-1` (path,
  structure label and text, questions keyed by position, no line numbers).
- Judges:
  - Jev `jev-1.13.0` and `jev-1.14.0` through TypeSafe direct
    ([bench:layouts](../../scripts/bench-layouts.ts));
  - OpenAI Luna Decisions (`POST /v1/decisions`, model `gpt-6-luna`, one predicate
    question per excerpt, which returns a probability);
  - `gpt-6-luna` and `gpt-6.1-terra` through `POST /v1/responses` with a strict JSON
    schema (one probability per excerpt), with reasoning effort `none` and `medium`
    ([bench-openai-judges.ts](../../scripts/bench-openai-judges.ts)).
- The default selection (threshold 0.5, 4,000-token response budget) is replayed
  offline with each judge's scores. The threshold was not retuned per judge.
- Metrics: R@1, R@5 and MRR on positive searches; counterevidence coverage on
  false-premise searches; the share of no-answer searches that return nothing.
- Cost uses list prices per million tokens: Jev $0.042 input; `gpt-6-luna` $0.10
  input, $0.01 cached, $0.50 output; `gpt-6.1-terra` $1.00 input, $0.05 cached, $5.00
  output (Vercel AI Gateway model listing, 2026-11-04). Time per search is the sum
  of its sequential request times.

## Results

| Judge | R@1 | R@5 | MRR | Counterevidence | No-answer correct | Input tokens | Output tokens (reasoning) | Cost / search | Time / search |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Jev 1.13.0 | 0.759 | 0.916 | 0.911 | 1.000 | 1.000 | 3,158,760 | 0 | $0.0020 | 6.1 s |
| Jev 1.14.0 | 0.781 | 0.913 | 0.922 | 1.000 | 1.000 | 3,158,760 | 0 | $0.0020 | 7.1 s |
| Luna Decisions | 0.596 | 0.934 | 0.841 | 0.750 | 0.667 | 3,249,676 | 0 | $0.0050 | 4.6 s |
| `gpt-6-luna`, no reasoning | 0.804 | 0.948 | 0.950 | 0.769 | 1.000 | 2,574,537 | 31,265 | $0.0042 | 8.0 s |
| `gpt-6-luna`, medium | 0.804 | 0.933 | 0.922 | 1.000 | 0.667 | 2,574,537 | 65,583 (34,733) | $0.0045 | 13.4 s |
| `gpt-6.1-terra`, no reasoning | 0.710 | 0.964 | 0.911 | 1.000 | 0.500 | 2,574,737 | 36,323 | $0.0424 | 11.6 s |
| `gpt-6.1-terra`, medium | 0.676 | 0.964 | 0.896 | 1.000 | 0.333 | 2,574,572 | 44,143 (7,602) | $0.0430 | 12.8 s |

Raw judgments: `judge-judgments-2026-11-04-*.json`; summary:
[judge-comparison-2026-11-04.json](judge-comparison-2026-11-04.json). The Jev 1.13.0
run is [the cache-identity run](layout-judgments-2026-11-04-typesafe-layout-a-nolines-1.json).

## Reading

- Jev is the only judge that is right on both reliability checks: it returns nothing
  on every no-answer search and finds the contradicting code on every false-premise
  search. The OpenAI judges find the expected evidence slightly more often (R@5 up to
  0.964) but return excerpts on searches that have no answer, Terra most of all.
- Jev is also 2 to 20 times cheaper per search. Luna Decisions is the fastest judge.
- Jev 1.14.0 and 1.13.0 are within run-to-run noise of each other.
- `gpt-6-luna` without reasoning returned invalid JSON for 6 of 126 requests; the 6
  affected searches are excluded from its quality figures.

## Limits

One run per judge. The reliability checks rest on 6 no-answer and 14 false-premise
searches. The OpenAI prompts are reasonable but untuned, and the 0.5 threshold is
Jev's.

Spend: about $6.50 on OpenAI and $0.13 on TypeSafe.
