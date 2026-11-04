# Whole declarations for split windows (2026-11-04)

## Question

A declaration larger than the window limits (about 80 lines) is cut into several
windows that Jev scores separately. The head of a long function often scores high
while its tail windows do not, so the search returned the head alone. Three of the
six Go/Rust questions still unanswered at the 8000-token budget were exactly that:
functions of 160 to 175 lines whose first window scored 0.94 to 0.96.

## Change

Each window cut from one declaration now remembers that declaration
(`PreparedFragment.declaration`). When such a window qualifies, selection admits the
whole declaration instead of the window, under the same budget and merge rules. When
the declaration does not fit, the window itself is offered as before. Jev still
scores the windows, so the cache and the evaluation input are unchanged.

## Method

Same offline replay as the response budget report: the pools captured on 2026-11-04
(Jev on TypeSafe) replayed through the real engine at 8000 tokens, with and without
the change.

```sh
npm run bench:compare -- --arms jevgrep-replay --replay <pool> --response-tokens 8000 [--go-rust]
```

## Results

| Set | Arm | R@1 | R@5 | MRR | Returned chars |
|---|---|---:|---:|---:|---:|
| Python (21) | windows | 0.714 | 0.877 | 0.823 | 22.7 k |
| Python (21) | whole declarations | 0.714 | 0.877 | 0.823 | 22.7 k |
| Go/Rust (32) | windows | 0.573 | 0.757 | 0.716 | 16.5 k |
| Go/Rust (32) | whole declarations | **0.667** | **0.827** | **0.802** | 17.3 k |

Python is unchanged: no evidence there spans a declaration longer than a window.
Go/Rust gains three questions for 5 % more returned text.

## Limits

- One replayed pass; the three questions that move are the three long-function
  `understand` questions of the set.
- The remaining Go/Rust misses are insertion points (a blank line or a constant
  block where the patch adds code), which no retriever scores from the question.
- No provider spend.
