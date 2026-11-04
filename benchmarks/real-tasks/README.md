# Real repository tasks

A bounded, pinned selection of SWE-bench tasks (`princeton-nlp/SWE-bench`, test split,
MIT) used for two separate measurements:

1. **Retrieval** (`npm run bench:real`): JevGrep on the pre-change snapshot, scored
   against the patch.
2. **Paired agent runs** (`npm run bench:agent`): the same agent, model, prompt and
   budget with and without a `jevgrep_search` tool.

Both runners are live and need an explicit trusted configuration and credential. The
offline checks (`tests/real-benchmark.test.ts`, `npm run bench:real -- --validate-only`)
need neither.

## Selection

`swe-bench-sample-1.json` is produced by `npm run bench:real:import` from a JSONL
subset of the dataset, with a seeded, per-repository ordering, at most 3 edited
non-test files per task and a bounded problem statement. Repositories and splits:

| Repository | Split | Tasks |
| --- | --- | --- |
| `psf/requests` | dev | 8 |
| `pallets/flask` | heldout | 4 |

Each task pins `base_commit` and the SHA-256 of the exported pre-change snapshot
(authorized text files only; `requests/packages/`, docs and examples are excluded).
Runners re-export snapshots from local mirrors in parallel and refuse a hash mismatch.
This is a public historical dataset: the held-out split is held out from tuning in
this repository, not a blind external test. Models may have seen these repositories.

### JavaScript and TypeScript tasks

`swe-bench-multilingual-js-1.json` is imported the same way from
`SWE-bench/SWE-bench_Multilingual` (test split, MIT) with seed `jevgrep-js-1`, for JS/TS
chunking experiments (`npm run bench:real -- --javascript`). It has no audit file:
labels come from the patches alone. Only library sources are exported.

| Repository | Split | Tasks | Exported paths |
| --- | --- | --- | --- |
| `preactjs/preact` | dev | 14 | `src/`, `hooks/src/`, `compat/src/`, `debug/src/`, `devtools/src/`, `jsx-runtime/src/`, `test-utils/src/` |
| `axios/axios` | heldout | 4 | `lib/`, `index.d.ts`, `index.js` |

JS/TS hunks are classified with JS comment and import rules, and these tasks have no
docstring-derived code-understanding queries.

### Go and Rust tasks

`swe-bench-multilingual-go-rust-1.json` is imported from the same dataset with seed
`jevgrep-go-rust-1`, for Go/Rust syntax chunking experiments (`npm run bench:real --
--go-rust`). It has no audit file. Only non-test Go/Rust sources are exported, and
patch edits to other files (changelogs, lockfiles, docs) are dropped instead of
disqualifying the task. Code-understanding queries quote the first sentence of the
Go or Rust doc comment of the edited function; a Go comment that starts with the
function name drops it.

| Repository | Split | Tasks | Exported paths |
| --- | --- | --- | --- |
| `caddyserver/caddy` | dev | 9 | root `*.go`, `caddyconfig/` |
| `sharkdp/bat` | dev | 6 | `src/` |
| `gin-gonic/gin` | heldout | 6 | `*.go` outside `examples/`, `docs/`, `testdata/` |
| `tokio-rs/axum` | heldout | 4 | `axum/src/`, `axum-extra/src/`, `axum-core/src/` |

Go and Rust hunks are classified with C-style comment rules and `import`/`use` lists.

### Large-repository tasks (hard set)

`swe-bench-multilingual-hard-1.json` is imported from the same dataset with seed
`jevgrep-hard-1` (`npm run bench:real -- --hard`). It exists to measure what the
smaller sets cannot: repositories above one million tokens of eligible sources, a
third language family (Java) and the scan budget itself. Import rules are the Go/Rust
ones (`maxEditFiles` 3, non-test sources only, edits to other files dropped), plus
Java with the same C-style comment classification. Repositories with fewer eligible
tasks than requested keep what they have instead of failing the import.

| Repository | Language | Split | Tasks | Queries | Exported paths | Eligible tokens |
| --- | --- | --- | ---: | ---: | --- | ---: |
| `prometheus/prometheus` | Go | dev | 7 | 10 | `*.go` outside `web/ui/`, `docs/`, `documentation/`, `vendor/`, `scripts/` | ~1.1M |
| `nushell/nushell` | Rust | dev | 5 | 7 | `crates/`, `src/` without `tests/`, `benches/` | ~1.8M |
| `projectlombok/lombok` | Java | dev | 8 | 8 | `src/` | ~0.7M |
| `gohugoio/hugo` | Go | heldout | 6 | 7 | `*.go` outside `docs/`, `testscripts/`, `examples/`, `vendor/` | ~1.2M |
| `astral-sh/ruff` | Rust | heldout | 7 | 10 | `crates/` without `tests/`, `resources/`, `snapshots/`, `benches/` | ~2.9M |
| `apache/lucene` | Java | heldout | 8 | 8 | `lucene/` without `src/test/`, `test-framework/`, `benchmark/` | ~6.7M |

Eligible tokens are Jev input tokens of one full scan at the pinned commit (the
per-query inventory varies with the exported paths). A full scan of one query costs
0.03–0.30 USD at the `jev-1.13.0` price, so this set is run once per split, with the
scan deadline raised to 20 minutes and the 8,000-token response budget.

### Go and Rust reliability set

`hand-go-rust-reliability-1.json` is hand-written on the four Go/Rust repositories
above, at the same pinned commits, to test the two behaviours an agent depends on
and that SWE-bench tasks never exercise:

| Category | Query | Required evidence | Correct outcome |
| --- | --- | --- | --- |
| `no-answer` | A plausible feature or behaviour that does not exist in the repository | none | No excerpt returned (`negativeCorrect`) |
| `false-premise` | A question asserting something the code contradicts | The code that contradicts the premise | The counter-evidence is returned |

| Repository | Split | `no-answer` | `false-premise` |
| --- | --- | ---: | ---: |
| `caddyserver/caddy` | dev | 2 | 2 |
| `sharkdp/bat` | dev | 1 | 2 |
| `gin-gonic/gin` | heldout | 2 | 3 |
| `tokio-rs/axum` | heldout | 2 | 2 |

Every `no-answer` query was checked against the pinned tree with grep and reading
before being kept; evidence ranges of `false-premise` queries are line-exact at the
pinned commit. Run it with `npm run bench:real -- --manifest
benchmarks/real-tasks/hand-go-rust-reliability-1.json`.

## Query categories and labels

| Category | Query | Required evidence | Complementary evidence |
| --- | --- | --- | --- |
| `change-localization` | Issue text | Pre-change lines of edit hunks | Placement of new definitions, test-patch ranges |
| `code-understanding` | First docstring sentence of an edited function | That function | — |
| `no-answer` | Hand-written question with no answer in the repository | none (an empty result is correct) | — |
| `false-premise` | Hand-written question whose premise the code contradicts | The contradicting code | Related definitions |

Automated labels ignore whitespace-only, import-only and documentation-only hunks.
A patch is one valid fix, so changed lines are neither exhaustive nor the only useful
evidence: complementary evidence is reported separately and never counts as a
required miss. `audit.json` records manual review of individual queries (`accepted`,
`amended` with replacement evidence, or `rejected`); it is applied when the manifest
is loaded, so labels change without regenerating the import.

## Retrieval metrics

Strict Recall@1/5, MRR and delivered coverage use required evidence, as in the
synthetic pilot. `fileRecall` (a required file appears), `firstOverlapRank` (first
excerpt touching required evidence) and `complementaryCoverage` are reported
alongside. Partial scans, provider errors and not-run queries stay in the planned
denominator. Held-out runs require `--frozen` with a manifest written by `--freeze`
before the run; it pins the dataset, product source, harness, lockfile, settings
and model alias (the remote model revision behind an alias cannot be pinned).

## Paired agent runs

- Agent: `openai/gpt-5-mini` via the Vercel AI Gateway chat completions API; tools
  `list_files`, `grep`, `read_file` (≤200 lines), `submit_locations` (≤5 ranges).
  The JevGrep arm adds `jevgrep_search`, which runs a real JevGrep search on the
  snapshot. Prompt, turn limit (16) and tool caps are identical across arms.
- Success: a submitted range overlaps a required unit within 3 lines. `fileHit`
  is reported separately.
- Recorded per run: status, tool calls, turns, files opened, rereads (overlapping
  re-reads), JevGrep calls, agent input/output tokens, agent cost (list price x
  reported tokens), Jev input tokens and cost, total cost (unknown when any usage is
  unknown), latency and setup time. Raw tool-event traces are kept in the report.
- Arm/task/repeat order is seeded and interleaved so provider drift does not align
  with one arm. Only (task, repeat) pairs where both arms completed contribute to
  deltas. Deltas carry 95% percentile bootstrap intervals that resample tasks, not
  runs, and are withheld below 8 pairs or 3 tasks; p95 is withheld below 20
  observations. Everything is also reported per repository.
- Not measured: index update cost (tasks are read-only), and task success as in
  SWE-bench (no patch is written or tested).

## Provider limits

The gateway key used for the first baseline returned frequent 429/503 responses
above one concurrent Jev request (about six successful Jev requests per minute).
Local export, validation and agent tool execution are parallel; provider-bound work
is throttled, and rate-limited searches remain visible as partial or error rows.
