# Language structure baseline, 2026-11-24

`npm run bench:languages` on `main` at `09b0669` (the chunker sources are unchanged in
the recording commit, which only adds the benchmark). Offline, default window limits,
Node 24.15.0 on Linux x64. Raw report: [languages-2026-11-24.json](languages-2026-11-24.json).
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
| TS | 482 | 169,047 | 2,204 | 93.4% | 0.3% | 14.1% | 0 | 74.0% | 123 | 0.0% | 15.0% | 0 | 14.4 | 0 |
| JS | 242 | 45,064 | 716 | 84.5% | 5.2% | 16.2% | 0 | 77.6% | 49 | 0.0% | 13.3% | 2 | 17.7 | 0 |
| Python | 2,388 | 546,837 | 8,643 | 87.4% | 1.3% | 1.2% | 1 | 83.3% | 104 | 0.0% | 83.6% | 0 | 14.0 | 0 |
| Java | 346 | 65,649 | 998 | 76.8% | 0.1% | 14.2% | 0 | 83.2% | 5 | 0.0% | 100.0% | 0 | 15.4 | 0 |
| Go | 427 | 138,087 | 2,107 | 78.7% | 2.4% | 10.3% | 0 | 63.1% | 113 | 0.0% | 97.7% | 0 | 16.8 | 0 |
| Rust | 363 | 61,617 | 941 | 89.2% | 0.9% | 7.9% | 215 | 78.6% | 12 | 0.0% | 100.0% | 0 | 16.1 | 0 |
| C | 319 | 303,768 | 5,220 | 0.0% | 0.1% | 59.5% | 0 | 100.0% | 1,445 | 0.0% | 100.0% | 0 | 18.3 | 0 |
| C++ | 48 | 27,932 | 437 | 0.0% | 0.0% | 60.0% | 0 | 100.0% | 127 | 0.0% | 100.0% | 0 | 19.6 | 0 |
| C# | 803 | 106,815 | 2,000 | 0.0% | 0.1% | 44.8% | 47 | 100.0% | 463 | 0.0% | 100.0% | 0 | 15.7 | 0 |
| PHP | 3,182 | 583,110 | 10,003 | 0.0% | 0.8% | 53.0% | 12 | 100.0% | 1,978 | 0.0% | 100.0% | 0 | 14.1 | 0 |
| Kotlin | 326 | 54,672 | 916 | 0.0% | 0.0% | 50.8% | 20 | 100.0% | 141 | 0.0% | 100.0% | 0 | 14.5 | 0 |
| Swift | 101 | 43,746 | 666 | 0.0% | 0.0% | 66.8% | 7 | 100.0% | 203 | 0.0% | 100.0% | 0 | 17.3 | 0 |
| Ruby | 159 | 24,964 | 420 | 0.0% | 0.7% | 49.5% | 0 | 100.0% | 17 | 0.0% | 100.0% | 0 | 13.1 | 0 |
| Shell | 39 | 3,760 | 73 | 0.0% | 1.4% | 24.7% | - | - | - | - | - | 0 | 15.8 | 0 |
| HTML | 749 | 312,593 | 6,457 | 0.0% | 3.9% | 67.2% | - | - | - | - | - | 0 | 25.3 | 0 |
| CSS/SCSS | 65 | 19,840 | 330 | 0.0% | 7.6% | 49.7% | - | - | - | - | - | 0 | 11.6 | 0 |
| YAML | 221 | 15,032 | 355 | 0.0% | 2.8% | 31.0% | - | - | - | - | - | 0 | 16.4 | 0 |
| JSON | 659 | 38,759 | 895 | 0.0% | 1.7% | 22.8% | - | - | - | - | - | 0 | 12.5 | 0 |
| Markdown | 305 | 70,324 | 2,042 | 0.0% | 0.9% | 16.7% | - | - | - | - | - | 0 | 26.4 | 0 |
| SQL | 11 | 360 | 16 | 0.0% | 12.5% | 0.0% | - | - | - | - | - | 0 | 21.7 | 0 |
| TOML | 121 | 2,002 | 127 | 0.0% | 29.1% | 1.6% | - | - | - | - | - | 0 | 13.0 | 0 |
| Vue | 12 | 838 | 21 | 0.0% | 4.8% | 33.3% | - | - | - | - | - | 0 | 12.8 | 0 |

`-`: no attribute syntax or declaration patterns for the group. Timings are from one
run on one host; compare them only with runs on the same machine.

## Gates (`--check`)

Every profiled language misses at least one 9.1 gate (16 misses, exit code 1):

| Gate | Missed by |
|---|---|
| Split callables with a declaration back-reference, 100% | all six (D1: 0%) |
| Continuations without label, 0% | all six (13% JS to 100% Java and Rust) |
| Detached attributes, 0 | Rust 215 (D2), Python 1 |
| Mid-block 15% or less | JS 16.2% |
| Fragments of 3 lines or fewer, 3% or less | JS 5.2% |

Coverage (0 uncovered lines) and parse fallback (2 of 4,248 syntax files, the two
Django-templated `.js` files) pass everywhere.

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
- **Labelled, mid-block, declarations hidden and detached attributes** are within a
  few points for every syntax language (Rust detached attributes 215 against 209);
  line-window detached counts are Kotlin 20, PHP 12, Swift 7 against 17, 15, 5.
- **Split callables and unlabelled continuations** match for Python, Java, Go and
  Rust (104/5/113/12 against 102/5/116/12). TS and JS differ (123 and 49 against 45
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
