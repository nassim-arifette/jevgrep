# Candidate priority and progressive search — 2026-11-03

Roadmap section 10: does a local lexical order help an explicitly partial scan find
the annotated evidence sooner, at a fixed scan budget? Answer on this dataset: **yes**.
A complete scan is unchanged (path order, same requests and tokens); only an allowed
partial scan uses the priority order, and it is still reported as partial.

## Setup

- Dataset: `swe-bench-sample-1` (21 questions; `psf/requests` dev, `pallets/flask`
  held-out), the E7 [score pool](../pools/e7-swe-bench-sample-1-scores.json) replayed
  offline through the ordinary engine (`npm run bench:progressive`). No provider request;
  this relies on Jev judging each fragment independently of its batch neighbors.
- Budgets: `estimated_input_tokens` or `candidate_files` capped at 10 %, 25 % and 50 %
  of each question's exhaustive scan, with `allow_partial_scan: true`.
- Orders (`lexical-priority-1`): `path` (previous behavior); `priority` (BM25 over
  question terms in fragment text, file name, directory and symbol label, file name and
  symbol weighted higher); `priority+reserve25` / `+reserve50` (every 4th / 2nd
  position taken from a path-order sweep, so less obvious candidates are reached early).
- A token cap smaller than one batch now admits the leading part of that batch that fits;
  before, such a partial scan evaluated nothing.
- Raw rows and summaries: [progressive-search-2026-11-03.json](progressive-search-2026-11-03.json).

"Candidate recall" is the share of annotated evidence inside the evaluated fragments;
"first useful batch" is the 1-based batch that first scores an annotated fragment
(useful-result latency in requests). The exhaustive scan is the cost reference, not an
oracle: R@k is measured against the annotations.

## Token caps (R@5 / candidate recall / first useful batch)

| Split | Budget | path | priority | priority+reserve25 | priority+reserve50 |
| --- | ---: | --- | --- | --- | --- |
| dev (15) | 10 % | 0.000 / 0.000 / – | **0.733 / 0.733 / 1.0** | 0.733 / 0.733 / 1.0 | 0.667 / 0.667 / 1.0 |
| dev | 25 % | 0.000 / 0.000 / – | **0.867 / 0.967 / 1.0** | 0.800 / 0.867 / 1.0 | 0.733 / 0.733 / 1.0 |
| dev | 50 % | 0.400 / 0.467 / 2.3 | **0.867 / 1.000 / 1.0** | 0.867 / 1.000 / 1.0 | 0.867 / 0.967 / 1.1 |
| dev | exhaustive | 0.867 / 1.000 / 2.6 | | | |
| held-out (6) | 10 % | 0.000 / 0.000 / – | **0.737 / 0.737 / 1.0** | 0.728 / 0.728 / 1.0 | 0.728 / 0.728 / 1.0 |
| held-out | 25 % | 0.167 / 0.184 / 2.0 | **0.811 / 0.921 / 1.2** | 0.728 / 0.820 / 1.2 | 0.728 / 0.820 / 1.2 |
| held-out | 50 % | 0.811 / 0.974 / 3.3 | **0.811 / 0.956 / 1.2** | 0.811 / 0.947 / 1.2 | 0.811 / 0.930 / 1.2 |
| held-out | exhaustive | 0.811 / 1.000 / 3.3 | | | |

Requests and tokens are the same for every order at a given budget (dev 25 %: 1.27
requests, about 20 k tokens per search against 4.07 and 82.6 k exhaustive). At 25 % and
50 % of the tokens, `priority` matches the exhaustive R@5 on all 21 questions (no
per-question regression); held-out R@1 is 0.794 against 0.750 exhaustive. At 10 % it
misses three questions the exhaustive scan finds (`requests-1657:change`,
`requests-1768:change`, `flask-4045:change`) and finds one it misses (`flask-4074:change`).
Path order loses because the dev repository sorts `docs/`, `tests/` and top-level
files before `requests/`.

## File caps (preparation order from paths alone)

| Split | Budget | path R@5 | priority R@5 | reserve25 | reserve50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| dev | 10 % / 25 % / 50 % | 0.000 / 0.000 / 0.133 | 0.300 / 0.267 / 0.400 | 0.300 / 0.267 / 0.400 | 0.133 / 0.267 / 0.333 |
| held-out | 10 % / 25 % / 50 % | 0.000 / 0.000 / 0.811 | 0.592 / 0.592 / 0.811 | 0.592 / 0.592 / 0.811 | 0.425 / 0.592 / 0.759 |

A file cap stops before fragment text is read, so only file and directory names rank
the files; the gain is smaller than with token caps.

## Continuation (25 % token cap, same search repeated four times)

Each repetition reuses the cached scores and sends only fragments not yet evaluated.

| Split | Order | Evaluated share after rounds 1–4 | R@5 after rounds 1–4 | Complete |
| --- | --- | --- | --- | ---: |
| dev | path | 0.27 / 0.51 / 0.76 / 0.97 | 0.000 / 0.400 / 0.733 / 0.867 | 0 |
| dev | priority | 0.21 / 0.42 / 0.66 / 0.96 | 0.867 / 0.867 / 0.867 / 0.867 | 0 |
| held-out | path | 0.26 / 0.48 / 0.78 / 0.99 | 0.167 / 0.811 / 0.811 / 0.811 | 0 |
| held-out | priority | 0.20 / 0.42 / 0.64 / 0.98 | 0.811 / 0.811 / 0.811 / 0.811 | 0 |

No round reports `complete` while fragments remain unevaluated (0 in every row). The
score cache key already binds each reused score to the question, the fragment path,
line range and exact text, its label, the criterion and layout versions, the chunker,
the endpoint and the model, so a changed file or question is re-evaluated; scope,
authorization, exclusions, secret scanning and caps are re-checked on every search.
`fragments.cache_reused` and `fragments.remote_evaluated` separate prior work from the
newly evaluated part.

## Decision

- Adopted: `priority` (reserve 0) as the order of an allowed partial scan, and leading
  part admission of the first batch that does not fit a size cap.
- Not adopted: the path-order reserve. It never improved R@5 here and lost evidence at
  25 % (dev 0.867 → 0.800, held-out 0.811 → 0.728). It stays available as
  `candidateOrder: { kind: 'priority', reserve }` for experiments.
- Not adopted: an adaptive stopping policy. A first high Jev score does not establish
  that the remaining evidence was found; stopping stays caused by caps only, and the
  stop reason (`SCAN_CAP_REACHED` / `PREPARATION_LIMIT`) is reported.
- Complete scans and the strict preflight are unchanged: a search without
  `allow_partial_scan` that exceeds an enabled cap is still refused before any request.

Limits: 21 questions on two Python repositories, scores from one Jev capture, and
continuation is a repeated search through the cache rather than an explicit token.
