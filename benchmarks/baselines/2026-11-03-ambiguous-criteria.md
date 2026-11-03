# Additional criteria on ambiguous candidates, 2026-11-03

Experiment E8 of roadmap section 14: the existing single relevance judgment against
focused judgments asked only for a bounded set of ambiguous candidates.
Raw report: [criteria-2026-11-03.json](criteria-2026-11-03.json). Judgments:
[rep 1](criteria-judgments-2026-11-03-1.json), [rep 2](criteria-judgments-2026-11-03-2.json),
[rep 3](criteria-judgments-2026-11-03-3.json). Pools: the three E2 pools plus
[false-premise-1](../pools/false-premise-1.json).

## Setup

- Single judgment: the captured candidate pools (`criterion-1`, threshold 0.5,
  4,000-token response budget). The 14 new false-premise questions
  (`scripts/bench/false-premise.ts`: 8 synthetic, 3 `psf/requests` in tuning, 3
  `pallets/flask` held-out) were captured live once the same way.
- Ambiguous set, predeclared: saved score in [0.2, 0.9), closest to the threshold
  first, at most 8 per search. 293 candidates over 65 searches; 5 searches had none.
- Focused judgments, each versioned and sent as its own request per search with the
  same excerpts and model-visible metadata: `focused-topic-1` (about the subject),
  `focused-evidence-1` (decides the behavior asked about), `focused-counter-1`
  (shows a premise of the question is false). Three repetitions; per-candidate
  spread between repetitions was at most 0.17 (mean 0.03).
- Routing arms combine the saved probabilities in code and replay the default
  selection offline. One arm is chosen on tuning (synthetic, requests dev and their
  false premises) by mean coverage of required evidence and counterevidence, with
  negative accuracy not lower and unannotated excerpts at most 10% higher than
  single. Held-out (flask) is scored once with it.
- Unannotated excerpts overlap no required or complementary unit. Real-task labels
  are not exhaustive, so this is a false-positive proxy, not a precision.

## Tuning split (56 searches, mean of 3 repetitions)

| Arm | R@1 | R@5 | MRR | Coverage | Counterevidence | Negatives | Unannotated | Worse | +requests | +input tokens | +ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single | 0.761 | 0.932 | 0.910 | 0.932 | 1.000 | 1.000 | 1.29 | - | 0 | 0 | 0 |
| evidence | 0.786 | 0.892 | 0.923 | 0.892 | 0.394 | 1.000 | 0.95 | 10 | 0.91 | 2,558 | 184 |
| mean(single,evidence) (chosen) | 0.786 | 0.932 | 0.923 | 0.932 | 0.818 | 1.000 | 1.10 | 4 | 0.91 | 2,558 | 184 |
| topic>=0.5 then evidence | 0.786 | 0.892 | 0.923 | 0.892 | 0.394 | 1.000 | 0.95 | 10 | 1.82 | 5,103 | 374 |
| mean(topic,evidence) | 0.786 | 0.929 | 0.923 | 0.929 | 0.818 | 1.000 | 1.03 | 4.3 | 1.82 | 5,103 | 374 |
| max(single,counter) | 0.761 | 0.932 | 0.910 | 0.932 | 1.000 | 0.667 | 1.34 | 2 | 0.91 | 2,512 | 182 |
| topic>=0.5 then max(evidence,counter) | 0.786 | 0.892 | 0.923 | 0.892 | 0.879 | 0.944 | 1.02 | 5.7 | 2.73 | 7,615 | 556 |

Costs are per search, averaged over all searches including those without ambiguous
candidates. All 11 arms are in the raw report.

## Held-out split (9 searches)

| Arm | R@1 | R@5 | MRR | Coverage | Counterevidence | Unannotated | Worse | +requests | +input tokens | +ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single | 0.750 | 0.811 | 0.917 | 0.811 | 1.000 | 1.33 | - | 0 | 0 | 0 |
| mean(single,evidence) | 0.750 | 0.811 | 0.917 | 0.811 | 0.667 | 1.22 | 1 | 1.00 | 6,212 | 244 |

## Decision

The single criterion stays. It already covered every required counterevidence unit
on the 14 false-premise questions: the current wording asks for evidence useful for
investigating the question, which includes code refuting its premise. The focused
evidence judgment removes about a quarter of unannotated excerpts but drops
counterevidence (0.39) and required evidence on 10 tuning searches; averaging it with
the single score keeps tuning coverage but still loses one held-out counterevidence
search (`fp-flask-03`) for an extra request per search. The counter judgment also
fires on true negatives (2 of 6 synthetic negatives answered), so it cannot be
used to rescue excerpts. No focused criterion is wired into searches; the
`EvaluationBatch.criterion` seam exists only for experiments and leaves production
payloads byte-identical.
