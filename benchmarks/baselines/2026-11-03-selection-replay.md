# Selection replay, 2026-11-03

Experiment E2 of roadmap section 8: the current relevance walk against MMR and a
marginal value per added serialized token, on identical candidates and scores.
Raw report: [selection-replay-2026-11-03.json](selection-replay-2026-11-03.json).
Pools: [synthetic-pilot-1](../pools/synthetic-pilot-1.json),
[swe-bench-sample-1 dev](../pools/swe-bench-sample-1-dev.json) and
[held-out](../pools/swe-bench-sample-1-heldout.json).

## Setup

- Pools captured live once with `typesafe-ai/jev` through Vercel AI Gateway, Linux x64,
  Node 24.22.2, threshold 0.5, 4,000-token response budget: 30 synthetic searches
  (190 candidates), 15 `psf/requests` dev searches (1,749) and 6 `pallets/flask`
  held-out searches (1,773). 148 requests, 2,417,175 reported input tokens, about
  US$0.10 at the configured US$0.042 per million.
- Every live response was reproduced exactly by replaying `relevance` at the captured
  budget (51 of 51, excerpts and report). No provider request is made by a replay.
- Tuning split: synthetic plus real dev (45 searches, 39 positive, 6 negative).
  Held-out: real held-out (6 positive). Parameters were picked on tuning by mean
  evidence coverage over the four budgets, then held-out was scored once.
- Redundancy signals are local: share of lines already covered, a shared structural
  label in the same file, identifier-set Jaccard similarity. No file or type quotas.

## Tuning split

| Arm | Budget | R@1 | R@5 | MRR | Coverage | Full sets | Negatives | Tokens | Excerpts | Worse searches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| relevance | 1,200 | 0.479 | 0.513 | 0.590 | 0.513 | 0.436 | 1.000 | 470 | 0.76 | - |
| relevance | 1,600 | 0.581 | 0.701 | 0.705 | 0.701 | 0.667 | 1.000 | 740 | 1.73 | - |
| relevance | 2,400 | 0.735 | 0.906 | 0.885 | 0.906 | 0.872 | 1.000 | 999 | 2.04 | - |
| relevance | 4,000 | 0.761 | 0.932 | 0.910 | 0.932 | 0.897 | 1.000 | 1,514 | 2.44 | - |
| mmr λ=0.85 (chosen) | 1,200 | 0.479 | 0.513 | 0.590 | 0.513 | 0.436 | 1.000 | 470 | 0.76 | 0 |
| mmr λ=0.85 (chosen) | 1,600 | 0.581 | 0.692 | 0.705 | 0.692 | 0.641 | 1.000 | 740 | 1.73 | 1 |
| mmr λ=0.85 (chosen) | 2,400 | 0.735 | 0.906 | 0.885 | 0.906 | 0.872 | 1.000 | 991 | 2.07 | 0 |
| mmr λ=0.85 (chosen) | 4,000 | 0.761 | 0.932 | 0.910 | 0.932 | 0.897 | 1.000 | 1,527 | 2.56 | 0 |
| marginal r=0.5 c=0 (chosen) | 1,600 | 0.581 | 0.692 | 0.705 | 0.692 | 0.641 | 1.000 | 740 | 1.73 | 1 |
| marginal r=0.5 c=0 (chosen) | 2,400 | 0.735 | 0.880 | 0.872 | 0.880 | 0.846 | 1.000 | 991 | 2.07 | 1 |
| marginal r=1 c=0.5 | 1,200 | 0.385 | 0.427 | 0.500 | 0.427 | 0.359 | 1.000 | 468 | 0.89 | 4 |
| marginal r=1 c=0.5 | 2,400 | 0.761 | 0.880 | 0.885 | 0.880 | 0.846 | 1.000 | 984 | 2.18 | 1 |

Tokens are the mean measured serialized response. All 15 non-default configurations
are in the raw report; none covers more required evidence than `relevance` on any
search at any budget. Cost-aware variants (`c` > 0) prefer small excerpts and lose
whole evidence units at tight budgets.

## Held-out split

| Arm | Budget | R@1 | R@5 | MRR | Coverage | Full sets | Tokens | Worse searches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| relevance | 2,400 | 0.583 | 0.583 | 0.667 | 0.583 | 0.500 | 1,561 | - |
| relevance | 4,000 | 0.750 | 0.811 | 0.917 | 0.811 | 0.667 | 2,987 | - |
| mmr λ=0.85 | 2,400 | 0.583 | 0.583 | 0.667 | 0.583 | 0.500 | 1,561 | 0 |
| mmr λ=0.85 | 4,000 | 0.750 | 0.811 | 0.917 | 0.811 | 0.667 | 2,993 | 0 |
| marginal r=0.5 c=0 | 2,400 | 0.583 | 0.583 | 0.667 | 0.583 | 0.500 | 1,561 | 0 |
| marginal r=0.5 c=0 | 4,000 | 0.750 | 0.794 | 0.917 | 0.794 | 0.667 | 2,975 | 1 |

At 1,200 and 1,600 tokens every arm returns no qualifying `flask` evidence: the
relevant syntax units alone exceed the excerpt budget.

## Calibration (tuning split, relevance, 4,000 tokens)

| Rule | R@5 | Coverage | Negatives | Tokens | Excerpts |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.3 | 0.949 | 0.949 | 0.667 | 1,595 | 2.91 |
| threshold 0.5 (default) | 0.932 | 0.932 | 1.000 | 1,514 | 2.44 |
| threshold 0.7 | 0.932 | 0.932 | 1.000 | 1,431 | 2.27 |
| threshold 0.8 | 0.906 | 0.906 | 1.000 | 1,303 | 1.96 |
| threshold 0.9 | 0.816 | 0.816 | 1.000 | 848 | 1.27 |
| top-k 1 | 0.761 | 0.761 | 1.000 | 832 | 0.87 |
| top-k 3 | 0.923 | 0.923 | 1.000 | 1,442 | 2.24 |
| score gap 0.1 | 0.889 | 0.889 | 1.000 | 1,057 | 1.60 |
| score gap 0.2 | 0.932 | 0.932 | 1.000 | 1,437 | 2.27 |

## Decision

The default stays `relevance`. Neither diversity order improved coverage, full
evidence sets or rank on either split, and both lost evidence on some searches.
`search.selection_policy` exposes `mmr` and `marginal` for further experiments.
A threshold of 0.7 or a 0.2 score gap returns about 5% fewer tokens at equal tuning
coverage; 0.3 gains coverage but answers two of six negatives with excerpts. These
are not adopted: the tuning split is small and the held-out split has no negatives.

## Limits

Six held-out searches and six negatives are too few to detect small effects. The
labels are required patch sites, not exhaustive relevance, so a diversity order that
adds useful context outside them is not credited. Scores are single live samples.
