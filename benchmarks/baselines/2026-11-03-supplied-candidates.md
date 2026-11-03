# Supplied candidates and focused reading, 2026-11-03

Roadmap section 9, Stage A: experiment E4 (complete authorized scan against lexical
and externally supplied file candidates at several list sizes) and the E5 baseline
(the current file-level `scope` on the files that hold the evidence, against reading
those files in full). Raw report: [supplied-candidates-2026-11-03.json](supplied-candidates-2026-11-03.json).

## Setup

- Same pools as the [selection replay](2026-11-03-selection-replay.md): 30 synthetic
  searches (24 positive, 6 negative), 15 `psf/requests` dev and 6 `pallets/flask`
  held-out searches, threshold 0.5, 4,000-token response budget, relevance selection.
- Every arm runs the real engine with the existing file-level `scope`, answered by the
  scores captured during the full scan (no provider request), so arms differ only in
  the files supplied. The full-scan arm reproduces every captured selection (51 of 51).
- Suppliers only rank files the authorized scan prepared, so a list never widens
  authorization. **Lexical**: BM25 over whole files. **Mentioned**: paths named in the
  question, resolved by unique suffix (an external supplier that only sees the
  question). **Supplied evidence files** (E5): the files holding the labelled
  evidence, as from an agent, IDE or graph tool that already located them.
- Candidate recall: share of evidence units whose file is in the list, before Jev.
  Coverage: share of evidence units overlapped by delivered excerpts. A scoped search
  reports coverage of the supplied files only; "missed (list)" counts evidence in files
  never supplied, which no second stage can recover.
- Jev tokens: the engine's preflight estimate for the supplied files. Agent tokens:
  candidate list + JevGrep response + full rereads of supplied files whose evidence
  the excerpts missed. Full read: reading every supplied file in full.

## E4: candidate lists

| Split | Arm | Files | Cand. recall | Coverage | Full sets | Missed (list / selection) | Jev tokens | Agent tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| synthetic | full scan | 6.3 | 1.000 | 0.972 | 0.917 | 0 / 2 | 1,190 | 647 |
| synthetic | lexical top-1 | 0.9 | 0.500 | 0.500 | 0.417 | 21 / 0 | 272 | 406 |
| synthetic | lexical top-3 | 2.4 | 0.799 | 0.799 | 0.708 | 8 / 0 | 568 | 553 |
| synthetic | lexical top-5 | 3.3 | 0.917 | 0.889 | 0.833 | 2 / 2 | 713 | 611 |
| synthetic | mentioned paths | 0 | 0.000 | 0.000 | 0.000 | 36 / 0 | 0 | 0 |
| real dev | full scan | 32.4 | 1.000 | 0.867 | 0.867 | 0 / 4 | 82,578 | 4,699 |
| real dev | lexical top-1 | 1 | 0.467 | 0.467 | 0.467 | 10 / 0 | 7,947 | 1,617 |
| real dev | lexical top-3 | 3 | 0.800 | 0.733 | 0.733 | 4 / 2 | 24,074 | 3,679 |
| real dev | lexical top-5 | 5 | 1.000 | 0.867 | 0.867 | 0 / 4 | 36,609 | 4,633 |
| real dev | lexical top-10 | 10 | 1.000 | 0.867 | 0.867 | 0 / 4 | 58,873 | 4,751 |
| real dev | mentioned paths | 0.9 | 0.333 | 0.333 | 0.267 | 11 / 0 | 4,656 | 1,145 |
| held-out | full scan | 104.7 | 1.000 | 0.811 | 0.667 | 0 / 13 | 198,840 | 7,556 |
| held-out | lexical top-1 | 1 | 0.500 | 0.500 | 0.500 | 22 / 0 | 7,494 | 2,071 |
| held-out | lexical top-3 | 3 | 0.737 | 0.737 | 0.667 | 13 / 0 | 32,866 | 2,782 |
| held-out | lexical top-5 | 5 | 0.974 | 0.811 | 0.667 | 3 / 10 | 55,994 | 7,408 |
| held-out | lexical top-10 | 10 | 0.974 | 0.811 | 0.667 | 3 / 10 | 93,780 | 7,508 |
| held-out | mentioned paths | 0.2 | 0.167 | 0.167 | 0.167 | 26 / 0 | 1,646 | 315 |

Synthetic top-10 equals top-5 (fixtures have at most a handful of matching files).
Negative questions stayed correct in every arm (6 of 6); lists with no candidate
return nothing, which is only correct because the questions were negative.

## E5: focused reading in fixed files

| Split | Searches | Files | Coverage | Full sets | Missed (selection) | Jev tokens | Agent tokens | Full read | Rereads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| synthetic | 24 | 1.46 | 0.972 | 0.917 | 2 | 398 | 553 | 108 | 0.08 |
| real dev | 15 | 1.13 | 0.933 | 0.867 | 2 | 8,682 | 3,245 | 6,158 | 0.13 |
| held-out | 6 | 1.33 | 0.811 | 0.667 | 13 | 12,821 | 7,190 | 9,568 | 0.67 |

## Live check

The replay assumes a scoped search receives the judgments of the full scan. The E5
arm was rerun against `typesafe-ai/jev` (Vercel AI Gateway) on the real splits:

| Split | Searches | Requests | Reported input tokens | Fragments | Mean / max abs score delta | Same excerpts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| real dev | 15 | 15 | 127,714 | 172 | 0.015 / 0.09 | 12 of 15 |
| held-out | 6 | 8 | 76,206 | 95 | 0.010 / 0.07 | 5 of 6 |

203,920 reported input tokens, about US$0.009 at US$0.042 per million. Scores drift
by about 0.01 between calls, which changes a near-threshold excerpt in 4 of 21
searches; coverage changed in one (`psf__requests-2821:change`, 0.5 to 0).

## Findings

- **E4.** A lexical top-5 list matched full-scan coverage on both real splits with
  56% (dev) and 72% (held-out) fewer Jev input tokens, but missed 3 held-out evidence
  units in files never supplied and lost 0.083 coverage on synthetic. Top-1 and top-3
  lose a third to a half of the evidence. Question-only path mentions are rare and
  recall poorly. Below the full scan, coverage is bounded by candidate recall, and the
  scoped report's coverage says nothing about the files left out.
- **E5.** On files that already hold the evidence, the current scoped search delivered
  the same coverage as the full scan (higher on dev, 0.933 against 0.867, because fewer
  competing ranges fill the budget) at 11% (dev) and 6% (held-out) of the full scan's Jev tokens. Agent
  context fell from 6,158 to 3,245 tokens on dev and from 9,568 to 7,190 on held-out
  including rereads; on synthetic the small files are cheaper to read in full.
- **Stage B is not justified yet.** The remaining E5 misses are ranges Jev scored below
  the threshold or that did not fit the budget inside supplied files; a range-level
  input would not recover them, and the file scope already gives the measured gain. No
  MCP tool or request schema is added.

## Limits

21 real searches from two repositories; one held-out repository dominates the
held-out misses (`pallets__flask-4074:change`). The agent-cost model is a simple
reread rule, not an agent trace, and does not charge the cost of finding evidence
in files a list left out. Lexical candidates use the same files the full scan
prepared, so exclusions and authorization are identical across arms.
