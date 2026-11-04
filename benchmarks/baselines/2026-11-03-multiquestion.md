# Multiquestion search: shared preparation (2026-11-03)

Roadmap section 13, related multiquestion experiment. Three questions over one scope,
run either as three separate searches (a fresh engine per question, as three CLI runs
would; only the persisted preparation cache is shared) or as one `searchMany` call
(one inventory and preparation for the scope). The provider answers locally and
instantly, so wall time measures local work only and nothing is sent. Queries are
unique per repetition so no arm benefits from score-cache reuse. Medians of 5
alternating repetitions after one warm-up search.

| Corpus | Separate (ms) | Shared (ms) | Saving | Provider attempts (separate / shared) |
| --- | ---: | ---: | ---: | ---: |
| cobra (Go) | 17300 | 15168 | 12.3 % | 18 / 18 |
| walkdir (Rust) | 3596 | 2813 | 21.8 % | 6 / 6 |
| clap (Rust) | 129400 | 116223 | 10.2 % | 102 / 102 |
| jevgrep `src` (TypeScript) | 11851 | 10983 | 7.3 % | 12 / 12 |

Sharing preparation saves 7-22 % of local time. Remote evaluation is unchanged: every
question pays for its own provider attempts, so additional questions are not free.
Most of the remaining local time is per-question batch serialization and response
assembly, which sharing preparation cannot remove.

Reproduce with `node scripts/bench-multiquestion.ts --corpus name=/path --questions 3
--repeats 5 --output out.json`; raw results are in `multiquestion-2026-11-03.json`.
