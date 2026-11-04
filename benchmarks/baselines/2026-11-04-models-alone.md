# JevGrep against models alone (2026-11-04)

Question: instead of using JevGrep, could a coding agent hand the whole repository to
a general model and ask it where the answer is?

## Method

- Questions: the same pinned real-task sets as the
  [CodeGraph comparison](2026-11-04-codegraph-comparison.md): 21 Python questions
  (`psf/requests`, `pallets/flask`) and 34 Go/Rust questions (`caddy`, `gin`, `axum`,
  `bat`). Every arm is scored on its returned ranges with the same localization
  metrics ([bench:compare](../../scripts/bench-compare.ts)).
- Model alone (`openai-solo`): one `POST /v1/responses` request per question
  containing every file of the snapshot that the other arms see, with 1-based line
  numbers, files first (the provider's prompt cache key is the snapshot), then the
  question. A strict JSON schema asks for up to ten `{path, start_line, end_line}`
  locations, best first; locations in unknown files are dropped and ranges are
  clamped to the file. Snapshots are 25 k to 230 k tokens.
- Models: `gpt-6-luna` and `gpt-6.1-terra`, reasoning effort `none` and `medium`.
  Requests that hit the organization's token-per-minute limit after all retries were
  re-run alone (`--only`); every question has an answer.
- JevGrep: current `main`, exhaustive scan, Jev `jev-1.13.0` through TypeSafe
  direct; the run is the one of the CodeGraph comparison.
- Cost uses list prices per million tokens: Jev $0.042 input; `gpt-6-luna` $0.10
  input, $0.01 cached, $0.50 output; `gpt-6.1-terra` $1.00 input, $0.05 cached, $5.00
  output (Vercel AI Gateway model listing, 2026-11-04). Time is the median per question.

## Python (21 questions)

| Arm | R@1 | R@5 | MRR | File recall | Input tokens / question | Cost / question | Time / question |
|---|---:|---:|---:|---:|---:|---:|---:|
| `gpt-6.1-terra`, medium | 0.812 | 0.894 | 0.929 | 0.976 | 227 k | $0.228 | 14.6 s |
| `gpt-6.1-terra`, no reasoning | 0.764 | 0.894 | 0.905 | 1.000 | 227 k | $0.228 | 15.4 s |
| JevGrep | 0.690 | 0.851 | 0.802 | 0.944 | 110 k | $0.0046 | 4.6 s |
| `gpt-6-luna`, no reasoning | 0.690 | 0.803 | 0.778 | 0.913 | 227 k | $0.021 | 4.1 s |
| `gpt-6-luna`, medium | 0.645 | 0.774 | 0.762 | 0.865 | 227 k | $0.023 | 11.5 s |

## Go/Rust (the 32 questions JevGrep completed)

| Arm | R@1 | R@5 | Input tokens / question | Cost / question | Time / question |
|---|---:|---:|---:|---:|---:|
| `gpt-6.1-terra`, medium | 0.596 | 0.737 | 122 k | $0.123 | 11.5 s |
| `gpt-6.1-terra`, no reasoning | 0.598 | 0.725 | 122 k | $0.122 | 9.4 s |
| `gpt-6-luna`, no reasoning | 0.536 | 0.688 | 122 k | $0.012 | 3.0 s |
| JevGrep | 0.573 | 0.687 | 110 k | $0.0046 | 3.6 s |
| `gpt-6-luna`, medium | 0.567 | 0.666 | 122 k | $0.012 | 10.2 s |

On all 34 questions the models score R@5 0.648 (`gpt-6-luna`, no reasoning), 0.627
(medium), 0.682 and 0.694 (`gpt-6.1-terra`). Raw rows:
`models-alone-2026-11-04-*.json`.

## Reading

- `gpt-6.1-terra` alone finds the expected evidence slightly more often than JevGrep
  (R@5 +0.04 on both sets) for 25 to 50 times the cost and about 3 times the time.
- `gpt-6-luna` alone is below JevGrep on Python, level on Go/Rust, and costs 3 to 5
  times more. Reasoning does not help either model here.
- A model alone only works while the whole authorized code fits its context window
  (about 1 M tokens for these models) and pays for all of it on every question.
  JevGrep scans repositories of any size within its caps and returns verbatim
  excerpts with exact line numbers.

## Limits

One run per arm. These sets contain no question without an answer, so they do not
test whether a tool stays silent when nothing matches; the
[judge comparison](2026-11-04-judge-comparison.md) does. Prompts are reasonable but
untuned.

Spend: about $19.70 on OpenAI (Terra $17.90 of it).
