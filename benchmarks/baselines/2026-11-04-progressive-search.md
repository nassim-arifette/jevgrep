# Progressive search: can JevGrep spend fewer Jev tokens without losing recall?

Date: 2026-11-04. Offline replay of captured Jev 1.13 scores (same 55 real questions as the
[head-to-head comparison](2026-11-04-head-to-head.md): 21 Python, 32 Go/Rust that completed).
No API cost: the engine plans, orders, batches and selects exactly as in production; only the
provider answers from the captured pool. Response budget fixed at 4 000 tokens for all arms
(the pool predates the 8 000 default), so absolute numbers are a little below the README.

Command: `node scripts/bench-progressive.ts [--go-rust] [--early-stop --batch-tokens 8000 --concurrency 2] --replay <pool> --mirrors <dir>`.

## Question

An exhaustive scan sends every fragment to Jev (about 80–190 k input tokens per Python
question, 90–140 k on Go/Rust). Two ways to send less:

1. **Hard budget** — evaluate only the first *x* % of the candidates in lexical-priority order
   (identifier, filename and symbol overlap with the question), then return a partial result.
2. **Confident early stop** — evaluate in priority order with small batches (8 k tokens,
   2 in flight); once at least `min_share` of the candidates are scored and `hits` scores
   reach `confident_score`, stop and return a partial result with a continuation token.

`dev` and `held-out` are the manifest splits; `tok` is the mean Jev input tokens per question.

## Hard budget (priority order, no reserve)

| Pool | Budget | dev R@1 | dev R@5 | dev tok | held R@1 | held R@5 | held tok |
|---|---:|---:|---:|---:|---:|---:|---:|
| Python | 25 % | 0.80 | 0.87 | 20 k | 0.77 | 0.81 | 48 k |
| Python | 50 % | 0.67 | 0.87 | 40 k | 0.77 | 0.81 | 96 k |
| Python | exhaustive | 0.67 | 0.87 | 80 k | 0.75 | 0.81 | 193 k |
| Go/Rust | 25 % | 0.64 | 0.67 | 35 k | 0.55 | 0.55 | 23 k |
| Go/Rust | 50 % | 0.59 | 0.71 | 70 k | 0.64 | 0.64 | 46 k |
| Go/Rust | 50 %, 25 % path reserve | 0.59 | 0.77 | 70 k | 0.64 | 0.64 | 45 k |
| Go/Rust | exhaustive | 0.64 | 0.76 | 141 k | 0.64 | 0.64 | 92 k |

Path order (no priority) at 25 % finds almost nothing (R@5 0.00–0.17), so the priority
ordering carries all of the effect.

## Confident early stop (8 k batches, 2 in flight)

| Pool | Rule | dev R@5 | dev tok | held R@5 | held tok |
|---|---|---:|---:|---:|---:|
| Python | ≥ 25 % scored, 1 hit ≥ 0.9 | 0.80 | 62 k | 0.64 | 115 k |
| Python | ≥ 25 % scored, 3 hits ≥ 0.9 | 0.87 | 87 k | 0.81 | 189 k |
| Python | exhaustive | 0.87 | 80 k | 0.81 | 193 k |
| Go/Rust | ≥ 25 % scored, 1 hit ≥ 0.9 | 0.74 | 93 k | 0.55 | 82 k |
| Go/Rust | ≥ 25 % scored, 3 hits ≥ 0.9 | 0.76 | 149 k | 0.64 | 99 k |
| Go/Rust | exhaustive | 0.76 | 141 k | 0.64 | 92 k |

With the production 64 k batches the rule never fires (2–4 batches per repository), which is
why the smaller batches are needed. `min_share` 0.1 vs 0.25 and a 25 % path reserve made no
difference; `confident_score` 0.95 only adds tokens.

## Reading

- **Priority order works on Python**: 25 % of the tokens gives the same R@5 as the full scan
  on both splits. On Go/Rust it needs 50 % (R@5 0.71–0.77 vs 0.76 on dev, equal on held-out);
  25 % loses 0.09.
- **A confident early stop is not a safe trade.** Stopping at the first 0.9 hit saves 20–40 %
  of tokens but drops 2 of 21 Python questions (the stop fired on a confident false positive
  before the evidence was reached) and 0.09 of held-out R@5 on Go/Rust. Requiring 3 hits almost
  never fires because most questions have one or two evidence units.
- **Partial results cannot abstain.** Any budgeted scan returns `partial`; the "nothing found"
  verdict that distinguishes Jev from the OpenAI judges needs the exhaustive scan.

## Decision

No default change. The exhaustive scan stays the default; cost-sensitive callers already have
`allow_partial_scan` plus the `estimated_input_tokens` / `estimated_cost_usd` scan caps, which
evaluate in the same priority order and hand back a continuation token. The `earlyStop` and
`batchLimits` engine options are benchmark seams kept on this branch, not wired to the CLI or MCP.

Limits: one pass per arm; Jev scores captured on 2026-11-04 (Jev 1.13); 2 Go/Rust questions
excluded because the exhaustive scan did not complete them; response budget 4 000 tokens.
