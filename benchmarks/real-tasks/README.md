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
subset of the dataset, with a seeded, per-repository ordering, at most 2 edited
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

## Query categories and labels

| Category | Query | Required evidence | Complementary evidence |
| --- | --- | --- | --- |
| `change-localization` | Issue text | Pre-change lines of edit hunks | Placement of new definitions, test-patch ranges |
| `code-understanding` | First docstring sentence of an edited function | That function | — |

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
