# Response budget: 4000 vs 8000 tokens (2026-11-04)

## Question

On the real task sets, JevGrep often scored the expected code above the threshold
but did not return it: with the default response budget of 4000 tokens only about
three function-sized excerpts fit (median 80 lines each). Does a larger budget turn
those scores into results, and at what cost in returned context?

## Method

The candidate pools captured during the CodeGraph comparison (same day, Jev on
TypeSafe, 21 Python and 34 Go/Rust questions) were replayed through the real engine
at several budgets, so the only variable is the budget:

```sh
npm run bench:compare -- --arms jevgrep-replay --replay <pool> --response-tokens <n> [--go-rust]
```

A second experiment capped the size of merged excerpts (40, 60 and 100 lines) at
4000 tokens to see whether shorter excerpts would let more of them in.

## Results

| Budget | R@1 Python | R@5 Python | R@1 Go/Rust | R@5 Go/Rust | Returned chars |
|---:|---:|---:|---:|---:|---:|
| 4000 (old default) | 0.690 | 0.851 | 0.573 | 0.687 | 8–10 k |
| 8000 (new default) | 0.714 | 0.877 | 0.573 | 0.757 | 16–23 k |
| 12000 | 0.714 | 0.877 | 0.573 | 0.765 | 20–29 k |
| 16000 | 0.738 | 0.901 | 0.573 | 0.777 | 21–31 k |

Capping merged excerpts changed nothing (R@5 identical at every cap): Go and Rust
fragments are already one function each, so the merge rule is not what fills the
budget.

In 9 of the 12 Go/Rust questions missed at 4000 tokens, the expected fragment had a
Jev score between 0.66 and 0.96 and was dropped only for lack of space.

## Decision

The default `search.default_response_tokens` is now 8000. It gives most of the gain
for twice the returned context; 16000 adds little and triples it. The caller can
still lower the budget per search with `--max-context-tokens`.

## Limits

- Replay of one live pass per question: Jev noise is not averaged out.
- R@5 counts the first five returned ranges, so a budget that returns fewer than
  five excerpts is penalised by construction; the gain is real for an agent only
  if it reads past the first three excerpts.
- Cost: no provider spend (offline replay).
