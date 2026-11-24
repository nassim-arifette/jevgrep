# Language structure baseline, 2026-11-24

`npm run bench:languages` on `main` at `c222427` (#11 to #15 merged: D1 to D7, chunker
versions js `-4`, python `-2`, java `jevgrep-java-scan-3`, go and rust `-3`). The
recording commit only adds the benchmark; the chunker sources are those of `main`.
Offline, default window limits, Node 24.15.0 on Linux x64. Raw report: [languages-2026-11-24.json](languages-2026-11-24.json).
Column definitions are in [the benchmark README](../README.md#language-structure-benchlanguages).

```sh
npm run bench:languages -- --check --output benchmarks/baselines/languages-2026-11-24.json
```

Corpus: the 14 repositories of spec 9.1 plus `App-vNext/Polly@ad7d87b` (C#), 11,368
measured files. Refused like a search would: 16 credential-pattern, 10 long-line, 2
non-UTF-8 and 2 blank files. Dropped prefixes: `sharkdp/bat` `tests/syntax-tests/` and
`redis/redis` `deps/`.

| Group | Files | Lines | Fragments | Labelled | <=3 lines | Mid-block | Detached attr. | Decl. hidden | Split callables | Split with decl. | Cont. unlabelled | Fallback files | ms/kLOC | Uncovered |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TS | 482 | 169,047 | 2,204 | 93.4% | 0.3% | 14.1% | 0 | 74.0% | 123 | 100.0% | 15.0% | 0 | 14.1 | 0 |
| JS | 242 | 45,064 | 716 | 84.5% | 5.2% | 16.2% | 0 | 77.6% | 49 | 100.0% | 13.3% | 2 | 15.3 | 0 |
| Python | 2,388 | 546,837 | 8,643 | 87.1% | 1.3% | 1.2% | 0 | 83.4% | 104 | 100.0% | 87.7% | 0 | 13.1 | 0 |
| Java | 346 | 65,649 | 996 | 77.1% | 0.0% | 14.3% | 0 | 83.2% | 5 | 100.0% | 100.0% | 0 | 12.9 | 0 |
| Go | 427 | 138,087 | 2,103 | 80.3% | 2.1% | 10.1% | 0 | 64.0% | 111 | 100.0% | 99.4% | 0 | 17.4 | 0 |
| Rust | 363 | 61,617 | 948 | 92.3% | 0.6% | 8.1% | 0 | 81.5% | 14 | 100.0% | 100.0% | 0 | 15.9 | 0 |
| C | 319 | 303,768 | 5,220 | 0.0% | 0.1% | 59.5% | 0 | 100.0% | 1,448 | 0.0% | 100.0% | 0 | 18.2 | 0 |
| C++ | 48 | 27,932 | 437 | 0.0% | 0.0% | 60.0% | 0 | 100.0% | 127 | 0.0% | 100.0% | 0 | 17.9 | 0 |
| C# | 803 | 106,815 | 2,000 | 0.0% | 0.1% | 44.8% | 47 | 100.0% | 463 | 0.0% | 100.0% | 0 | 15.3 | 0 |
| PHP | 3,182 | 583,110 | 10,003 | 0.0% | 0.7% | 53.0% | 12 | 100.0% | 1,978 | 0.0% | 100.0% | 0 | 13.9 | 0 |
| Kotlin | 326 | 54,672 | 916 | 0.0% | 0.0% | 50.8% | 20 | 100.0% | 141 | 0.0% | 100.0% | 0 | 12.6 | 0 |
| Swift | 101 | 43,746 | 666 | 0.0% | 0.0% | 66.8% | 7 | 100.0% | 203 | 0.0% | 100.0% | 0 | 15.3 | 0 |
| Ruby | 159 | 24,964 | 420 | 0.0% | 0.7% | 49.5% | 0 | 100.0% | 17 | 0.0% | 100.0% | 0 | 12.1 | 0 |
| Shell | 39 | 3,760 | 73 | 0.0% | 1.4% | 24.7% | - | - | - | - | - | 0 | 15.8 | 0 |
| HTML | 749 | 312,593 | 6,457 | 0.0% | 3.9% | 67.2% | - | - | - | - | - | 0 | 22.8 | 0 |
| CSS/SCSS | 65 | 19,840 | 330 | 0.0% | 7.6% | 49.7% | - | - | - | - | - | 0 | 11.6 | 0 |
| YAML | 221 | 15,032 | 355 | 0.0% | 2.8% | 31.0% | - | - | - | - | - | 0 | 15.6 | 0 |
| JSON | 659 | 38,759 | 895 | 0.0% | 1.7% | 22.8% | - | - | - | - | - | 0 | 12.2 | 0 |
| Markdown | 305 | 70,324 | 2,042 | 0.0% | 0.9% | 16.7% | - | - | - | - | - | 0 | 26.0 | 0 |
| SQL | 11 | 360 | 16 | 0.0% | 12.5% | 0.0% | - | - | - | - | - | 0 | 20.8 | 0 |
| TOML | 121 | 2,002 | 127 | 0.0% | 29.1% | 1.6% | - | - | - | - | - | 0 | 12.4 | 0 |
| Vue | 12 | 838 | 21 | 0.0% | 4.8% | 33.3% | - | - | - | - | - | 0 | 12.5 | 0 |

`-`: no attribute syntax or declaration patterns for the group. Timings are from one
run on one host; compare them only with runs on the same machine.

## Gates (`--check`)

8 misses, exit code 1. Against the first recording on `09b0669` (16 misses):

| Gate | `09b0669` | `c222427` |
|---|---|---|
| Uncovered lines, 0 | pass | pass |
| Parse fallback, 1% of files or less | pass (2 of 4,248: the two Django-templated `.js` files) | pass (same 2) |
| Detached attributes, 0 | Rust 215 (D2), Python 1 | pass (Rust 0 after #11) |
| Split callables with a declaration back-reference, 100% | all six, 0% (D1) | pass (after #15) |
| Mid-block, 15% or less | JS 16.2% | JS 16.2% |
| Fragments of 3 lines or fewer, 3% or less | JS 5.2% | JS 5.2% |
| Continuations without label, 0% | all six | all six: TS 15.0%, JS 13.3%, Python 87.7%, Java 100%, Go 99.4%, Rust 100% |

What the remaining misses mean:

- **Continuations without label** is expected. LS-4 (label a continuation with the
  declaration it continues) is phase 6 of spec section 10 and ships per language only
  after the live gate of 9.3. #15 fixed D7 by dropping the nested-symbol label, as
  LS-4 asks, without adding the continuation label yet, which raised Python from 83.6%
  to 87.7% and Go from 97.7% to 99.4%. The gate stays at 0%.
- **JS mid-block 16.2%** is mostly corpus. Of 116 mid-block fragments, 48 are in
  vendored, bundled code (`bat/tests/benchmarks/highlighting-speed-src/jquery.js`, 24;
  two copies of Alamofire's generated `docs/**/typeahead.jquery.js`, 24); without them
  JS is at 13.4%. Most of the rest are nested `describe` callbacks of Express tests
  cut inside their bodies, which is the phase-1 shared planner's work (LS-1, D8).
- **JS small fragments 5.2%** is a gate definition question, not a chunker defect.
  Of 37 small fragments out of 716, 15 are line windows of
  `django/views/templates/i18n_catalog.js` (a Django template that does not parse,
  already counted by the fallback gate), and most others are whole files of 1 to 3
  lines (Django i18n and staticfiles test fixtures) that cannot give a longer
  fragment. Not counting fragments that span their whole file would make JS pass;
  the gate is unchanged here and that choice is left to the spec.

The `09b0669` column is the report recorded before the rebase, with the metric of
that time. Two metric fixes come with this recording: the detached-attribute check
follows strings across lines and stops at comments (Django's one Python miss was a
`@setup` decorator holding a triple-quoted template), and a split callable whose inner
fragments record a split declaration nested in it counts as back-referenced, because a
fragment records one range, the innermost (#15's design). Declaration brace matching
also skips Go raw strings and Rust multi-line and raw strings, which moves Go split
callables from 113 to 111 and Rust from 12 to 14.

## Against spec section 2.2

The spec's run was ad hoc and did not record its extension lists, exclusions or
declaration patterns, so this baseline reproduces it approximately:

- **Files** are within 4% for every syntax language. Refusals a search applies
  (long lines, credential patterns) and the dropped `bat/tests/syntax-tests/` remove a
  few files; the latter are the eight ANSI-coloured fixtures that made up most of the
  spec's 10 fallbacks, so 2 remain. `bat/tests/integration_tests.rs` (a 16 KB line)
  and the syntax tests also explain Rust's 941 fragments against 1,079.
- **C** matches (319 against 320 files) only with `redis/redis` `deps/` dropped,
  so the spec evidently left vendored code out; with it C has 877 files.
- **Labelled, mid-block, declarations hidden and detached attributes** were within a
  few points for every syntax language on `09b0669` (Rust detached attributes 215
  against 209; 0 now that #11 attaches Rust attributes);
  line-window detached counts are Kotlin 20, PHP 12, Swift 7 against 17, 15, 5.
- **Split callables and unlabelled continuations** match for Python, Java, Go and
  Rust (104/5/111/14 against 102/5/116/12; unlabelled continuations differ by D7's
  change, above). TS and JS differ (123 and 49 against 45
  and 8; 15% and 13% unlabelled against 36% and 50%): these patterns also count class
  methods and arrow functions bound to a `const`, which the spec's apparently did not,
  and those split pieces are mostly labelled.
- **Line-window groups** match on file counts and roughly on mid-block share (PHP,
  HTML, C, Markdown, JSON within a point or three). C++, Swift, Ruby, CSS and YAML
  have similar file counts but fewer fragments and some mid-block shares that differ by
  5 to 17 points (C++ 60.0% against 43.2%). Not reconciled: the spec's extension sets
  for these groups are not recorded (for example whether fmt's `.h` headers counted as
  C or C++), and their files are few enough that a handful of large files moves the
  share.
