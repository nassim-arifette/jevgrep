# Benchmarking JevGrep

This directory records reproducible measurement baselines. The local suite
measures real preparation, planning, caching, selection and rendering with a fixed
offline provider. The retrieval pilot measures real Jev judgments on annotated,
original synthetic sources. Keep their results separate.

The first recorded run is the [2026-09-21 Windows baseline](baselines/2026-09-21.md).
Follow-up reports cover [grouped cache writes](baselines/2026-09-22-cache-bulk.md)
and [batch measurement reuse](baselines/2026-09-22-batching-reuse.md).

## Local performance

```sh
npm run bench
npm run bench -- --files 256 --samples 3 --output benchmark-results/local-256.json
npm run bench -- --files 64 --samples 3 --no-profile --output benchmark-results/local-unprofiled.json
npm run bench:cache -- --pairs 5
```

The default is 64 generated TS, Python and SQL files, three independent samples,
one provider worker and a 4,000-reference-token response budget. File generation is
deterministic; each report records its content hash. Each sample runs in a new child
process with a fresh temporary repository and score cache. Network entry points in
the child are blocked. There are no dependencies to download or credentials to set.

Each sample executes these scenarios in order:

| Scenario | Query | Files | Expected score-cache state |
| --- | --- | --- | --- |
| `cold` | A | Original | All misses |
| `repeat_question` | A | Unchanged | All hits; zero provider attempts |
| `new_question` | B | Unchanged | All misses |
| `small_edit` | A | One changed numeric literal in one file | Changed content misses; other files hit |

The runner checks these conditions and fails if a search is incomplete. Preparation
currently runs again in every scenario; there is no persistent preparation index.
Temporary files and caches are removed after each sample. The repository being
developed and the user's real cache are not benchmark inputs.

`bench:cache` is a separate paired microbenchmark of 64 individual score-cache
writes versus one grouped write. It verifies score read-back and alternates the
order of the two paths. It measures cache persistence only, not a full search.

`bench:cancellation -- --root <repository>` measures how long preparation keeps
running after a stop is due (`--after-ms`, default 200), as an MCP cancellation
would request it. The synchronous arm cannot see the stop until preparation ends;
the cooperative arm used by searches returns to the event loop at least every 10 ms,
between directory entries and between files, so the largest single file bounds the
latency. On clap (631 eligible files, about 12 s of preparation) the latency fell
from 11.1 s to 6 ms (median of three); on the Go source tree (14 065 eligible files,
about 186 s of preparation, inventory included) it fell from 183 s to 7 ms.

Reports contain raw samples and min/median/max summaries, Node/OS/CPU information,
Git revision and working-tree status, source and lockfile fingerprints, elapsed
time, cache/fragment counts, response tokens and modeled transmission volume.
Generated reports go under ignored `benchmark-results/`; retain a reviewed baseline
under `benchmarks/baselines/` when a comparison needs to survive a checkout.

## Interpreting profiles

Profiling is opt-in through `SearchInvocation.profile`. CLI/MCP result schemas are
unchanged. The profiler records numeric aggregates, without paths, queries or source.
Concurrent searches receive separate measurement contexts.

| Measurement | Meaning |
| --- | --- |
| `search` | The whole engine invocation including disposal; excludes process startup/imports, fixture/config setup and report writing |
| `inventory`, `source_read`, `decode`, `hash`, `secret_scan` | Authorized inventory, reads and individual preparation operations |
| `snapshot`, `chunking`, `parsing` | Inclusive preparation work; snapshot/chunking include their nested tokenizer work |
| `tokenization` | All calls to the reference BPE counter, including lazy tokenizer initialization on the first call |
| `cache_lookup`, `cache_write` | Identity construction plus score lookup; score persistence |
| `batching`, `planning`, `serialization` | Batch packing, scan-cap planning and engine-requested serialization |
| `evaluation`, `provider` | Scheduler wall time; sum of adapter calls including serialization, response handling and waiting |
| `selection`, `freshness`, `rendering` | Result selection, selected-source revalidation and response-budget/rendering work |
| `serializedQuestions`, `serializedBytes` | Repeated work in engine-requested serializations, not transmitted volume |
| `referenceTokensCounted`, `tokenizerInputUtf16` | Total tokenizer work including repeated inputs, not billing |

Durations are inclusive and overlap. **Do not sum stages**, subtract all nested
values to claim exclusive CPU time, or interpret concurrent provider duration as
wall time. Internal provider serialization is inside `provider`, not the engine's
`serialization` counter. Retries are included.

Memory is sampled at instrumented boundaries at most about every 20 ms, plus search
start/end. The observed RSS/heap/external maxima can miss a short-lived peak and
include memory already retained by the process. `processPeakRssBytes` is the OS
high-water mark over the entire child process, including setup and all four searches.

`initialTimerDelayMs` measures when a zero-delay timer scheduled just before search
first gets to run. It exposes blocking during initial synchronous work, but is not
a continuous event-loop latency distribution or a cancellation benchmark.

“Cold” means a fresh process/tokenizer/score cache. The OS filesystem cache is not
flushed. Run comparisons on the same host without competing builds/tests. Inspect
the sample spread; use `--no-profile` to assess measurement overhead. Three samples
are a pilot, not a statistically robust performance claim. The fixed provider's
numeric usage is synthetic and its scores have no semantic meaning.

## Retrieval pilot

Validate annotations offline:

```sh
npm run bench:retrieval -- --validate-only
```

Run real evaluation using an existing trusted provider configuration:

```sh
npm run bench:retrieval -- --config /path/to/config.json --max-requests 60 --max-input-tokens 200000
```

The configuration must enable remote evaluation. Credentials resolve as in the CLI,
from the environment or the existing profile's secrets file, and are never written
to the report. Only temporary copies of the three synthetic fixture repositories
are searched and transmitted. Their README authorizes remote test evaluation.
The configuration's original repository is not searched.

The runner inherits provider, pricing, search policy and existing scan caps; fixes
source policy to fixture defaults; disables the score cache; and defaults to the
same 4,000-token output budget. Override with `--response-tokens` within the trusted
configuration's maximum. Request and estimated input-token limits apply across the
whole run, including retries, with reservations made before dispatch. Unknown usage
retains its reservation. An estimate is not a guaranteed provider billing ceiling.
Incomplete or skipped questions are reported explicitly and make the command exit
nonzero. Reports include requested/returned outcomes, exact excerpts and profiles.

The dataset is [synthetic-pilot-1](../scripts/bench/dataset.ts): 30 questions on three
small repositories, including six negatives and cross-file questions, exact symbol
lookups and paraphrases. Fixture contents are pinned with SHA-256 after LF
normalization. Changes require reviewing labels and updating the dataset version.
Reports also fingerprint the questions, so wording changes remain visible.

An evidence unit is a required inclusive line range. Recall@1 and Recall@5 measure
the fraction of a question's required units fully covered by the first one/five
returned excerpts. Adjacent excerpts can jointly cover a unit; overlaps and
duplicates do not create extra credit. MRR uses the first returned excerpt that
fully covers at least one unit. Full-budget evidence coverage uses all returned
excerpts. These are metrics on the actual delivered excerpts, after merging and
budget selection, not on the internal candidate ranking.

Positive metrics are macro-averaged over complete positive searches. Negative
accuracy counts complete, fully scanned results with no excerpt. Partial scans and
provider errors are ineligible, never successful negatives; always read completion
counts alongside quality scores. The labels specify required evidence rather than
an exhaustive set of every possibly useful excerpt, so this pilot does not report
precision. Large excerpts can cover more evidence; retain the same output budget
for comparisons.

This is a development pilot, not a held-out tuning set. Larger realistic repositories,
rename/decoy stress tests, annotated Python/Rust/Go cases, agent task success, live
MCP interoperability and cancellation latency remain follow-up work.

## Selection replay

Candidate selection can be compared offline on identical candidates and scores.
Live runners write every evaluated candidate of each search, with its saved score
and the report inputs, when given `--capture`:

```sh
npm run bench:retrieval -- --config /path/to/config.json --capture benchmark-results/pools-synthetic.json
npm run bench:real -- --config /path/to/config.json --split dev --capture benchmark-results/pools-real-dev.json
```

Pools hold ranges, hashes and scores, never source text. The replay re-slices the
same pinned fixture or snapshot, refuses any file whose SHA-256 differs, and runs
only local selection and rendering, so it makes no provider requests:

```sh
npm run bench:replay -- --tuning benchmarks/pools/synthetic-pilot-1.json,benchmarks/pools/swe-bench-sample-1-dev.json \
  --heldout benchmarks/pools/swe-bench-sample-1-heldout.json [--budgets 1200,1600,2400,4000]
```

Each arm (`relevance`, `mmr`, `marginal` and their parameters) is measured at every
response budget on the delivered excerpts, after merging, metadata and the measured
envelope. Parameters are chosen on the tuning pools only; held-out pools are scored
once with the chosen ones. The report also lists counterexamples, searches where an
arm covers a different share of required evidence than `relevance`, and a calibration
sweep of threshold, top-k and score gap including the negative questions. Replaying
`relevance` at the captured budget reproduces the captured live responses exactly.
The [2026-11-03 report](baselines/2026-11-03-selection-replay.md) records the first
comparison; the captured pools are in [pools](pools/).

## JS/TS chunking comparison (E1)

`--chunker <arm>` on `bench:real` and `bench:retrieval` swaps how JS/TS files are
chunked; every other file keeps the production chunker, and each arm has its own
preparation-cache identity. The arms are defined in
[chunking-arms.ts](../scripts/bench/chunking-arms.ts):

| Arm | Boundaries | Model-visible label |
| --- | --- | --- |
| `line-windows` | JG-012 line windows | none |
| `typescript-v2` | previous depth-indexed packing (`jevgrep-typescript-6.0.2-2`) | symbol that starts the range |
| `recursive` (production) | recursive descent into oversized nodes, sibling packing | symbol that starts the range |
| `recursive-compact` | recursive | enclosing chain, names only |
| `recursive-enclosing` | recursive | enclosing chain with signatures and spans |

Boundaries and labels are separate variables: the three `recursive*` arms produce the
same line ranges. The JS/TS task set is `--javascript`
([real-tasks/README.md](real-tasks/README.md#javascript-and-typescript-tasks)):

```sh
npm run bench:chunking   # offline: fragment shape and where evidence lands, no provider call
npm run bench:real -- --javascript --chunker typescript-v2 --config <trusted-config> --split dev
```

Jev scores vary slightly between identical runs, so compare arms over several
repetitions and per query; near-tied fragments decide many Recall@1 differences. A
captured candidate pool cannot replay a chunking change, because the pool itself is
made of fragments, so arms must be run live.

## Go/Rust chunking comparison

`go-rust-line-windows` replaces Tree-sitter boundaries with line windows for Go and
Rust files only; `recursive` is production. The task set is `--go-rust`
([real-tasks/README.md](real-tasks/README.md#go-and-rust-tasks)). Over four live
repetitions on TypeSafe `jev-1.13.0`, syntax chunking matched or beat line windows on
every held-out metric (R@5 0.623 against 0.538) with 6–8 % fewer input tokens, while
line windows had a higher dev R@1 (0.649 against 0.573) driven by four queries. Syntax
chunking stays the default. See the
[2026-11-04 results](baselines/2026-11-04-go-rust-chunking.md).

## Additional criteria on ambiguous candidates (E8)

Focused Jev judgments are compared with the single relevance judgment on a bounded
set of ambiguous candidates from captured pools, including false-premise questions
whose useful evidence refutes the question:

```sh
npm run bench:criteria -- capture --config /path/to/config.json   # false-premise pools, live
npm run bench:criteria -- judge --config /path/to/config.json --output benchmark-results/criteria-judgments-1.json
npm run bench:criteria -- analyze --judgments benchmark-results/criteria-judgments-1.json[,...]
```

`judge` sends one request per search and focused criterion; `analyze` makes no
request. Each criterion is versioned in the request state. See the
[2026-11-03 results](baselines/2026-11-03-ambiguous-criteria.md).

## Relationship expansion (E7)

`bench:compare` can compare candidate-proposal strategies at one Jev allowance
without provider spend. A live exhaustive run with `--capture` saves every
fragment's Jev score (hashes, ranges and scores, never source text); replay arms
then run the ordinary engine on the same snapshot while only their candidates can
score, and report candidate recall, Jev tokens and cost for the candidate set:

```sh
npm run bench:compare -- --arms jevgrep --config /path/to/config.json --capture benchmark-results/e7-scores.json
npm run bench:compare -- --arms jevgrep-replay,e7-hop0,e7-adjacent,e7-hop1,e7-hop2,codegraph-jevgrep \
  --replay benchmarks/pools/e7-swe-bench-sample-1-scores.json --budget 16 --seeds 8 [--fanout 4] [--graph-behind 100]
```

`e7-hop0` evaluates the top lexical fragments; `e7-hop1`/`e7-hop2` replace half of
them with one or two bounded CodeGraph relation hops; `e7-adjacent` is the
same-file locality control; `codegraph-jevgrep` lets CodeGraph's `context` command
propose candidates. Graph arms need a `codegraph` binary (`--codegraph`); a missing
or unreadable index falls back to the lexical ranking. `--graph-behind` indexes an
older commit to measure a stale graph. The report adds paired per-question
differences against `e7-hop0` and cold/sync index costs. The
[2026-11-03 report](baselines/2026-11-03-graph-expansion.md) found no robust gain.

## Supplied candidates

Roadmap section 9 compares a complete authorized scan with lexical and externally
supplied file candidates (E4) and measures focused reading in fixed files (E5). Each
arm runs the real engine with the existing file-level `scope`, answered by the scores
captured during the full scan, so arms differ only in the supplied files and no
provider request is made:

```sh
npm run bench:candidates -- --config /path/to/config.json --pools benchmarks/pools/swe-bench-sample-1-dev.json [--sizes 1,3,5,10]
```

Candidates are ranked only among files the full scan prepared, so a list never widens
authorization. The report separates evidence missed because its file was never
supplied from evidence missed by selection inside supplied files, and states that a
scoped search's coverage refers to the supplied files only. `--live "<arm>"` reruns one
arm against the configured provider under `--max-requests` and `--max-input-tokens`
caps and compares fresh scores with the captured ones. The
[2026-11-03 report](baselines/2026-11-03-supplied-candidates.md) records the first run.

## Compact Jev payloads (section 11)

`bench:layouts` re-judges every captured candidate under one versioned request
layout, on identical chunks, then replays the default selection offline with each
layout's scores:

```sh
npm run bench:layouts -- judge --config /path/to/config.json --layout layout-a-1 --output benchmark-results/layouts-a.json
npm run bench:layouts -- judge --config /path/to/config.json --layout layout-compact-state-1 --output benchmark-results/layouts-state.json
npm run bench:layouts -- analyze --judgments benchmark-results/layouts-a.json,benchmark-results/layouts-state.json[,...]
```

`analyze` needs a `layout-a-1` rerun as the reference and uses the captured pool
scores as a second layout-A sample for the noise floor. It reports quality per
group, score agreement and cost. The
[2026-11-03 report](baselines/2026-11-03-compact-payloads.md) kept `layout-a-1`.

## Progressive search (section 10)

`bench:progressive` replays the E7 score pool through the ordinary engine with
`allow_partial_scan: true` and compares candidate orders (path order, lexical
priority, priority with a 25 % or 50 % path-order reserve) at token and file caps
set to fractions of each question's exhaustive scan, plus repeated searches that
continue a partial scan through the score cache. It makes no provider request:

```sh
npm run bench:progressive -- [--replay benchmarks/pools/e7-swe-bench-sample-1-scores.json] [--budgets 0.1,0.25,0.5]
```

Each row reports localization metrics on the delivered excerpts, candidate recall
(annotated evidence inside the evaluated fragments), the first batch that scores a
useful fragment, requests, tokens, evaluated share, complete searches and newly
delivered excerpts. See the [2026-11-03 results](baselines/2026-11-03-progressive-search.md).

## Judges inside JevGrep

`bench:judges` keeps JevGrep's chunks and selection and swaps the judge: every
captured candidate of the E2/E8 pools is scored by OpenAI Luna Decisions
(`/v1/decisions`) or by a chat model through `/v1/responses` with a strict JSON
schema, then `compare` replays the default selection with each judge's scores next
to Jev runs from `bench:layouts`:

```sh
npm run bench:judges -- judge --arm decisions --model gpt-6-luna --output benchmark-results/luna-decisions.json
npm run bench:judges -- judge --arm chat --model gpt-6.1-terra --effort medium --output benchmark-results/terra-medium.json
npm run bench:judges -- compare --judgments jev.json,luna-decisions.json,terra-medium.json --labels jev,luna,terra \
  --prices "0.042,0.042,0;0.10,0.01,0;1.00,0.05,5.00"
```

`judge` needs `OPENAI_API_KEY`; `--prices` is input, cached input and output USD per
million tokens for each file. See the [2026-11-04 results](baselines/2026-11-04-judge-comparison.md).

## Models and tools alone

`bench:compare` also runs a model without JevGrep (`openai-solo`): the whole
snapshot, with line numbers, goes into one request and the model returns up to ten
locations. With `--go-rust` every arm uses the Go/Rust task set:

```sh
npm run bench:compare -- --arms openai-solo --openai-model gpt-6-luna --openai-effort none [--go-rust]
npm run bench:compare -- --arms ripgrep,bm25,codegraph-query,codegraph-context --codegraph /path/to/codegraph [--go-rust]
```

See the [CodeGraph comparison](baselines/2026-11-04-codegraph-comparison.md) and the
[models-alone comparison](baselines/2026-11-04-models-alone.md).

## Response budget

The default response budget moved from 4000 to 8000 tokens after replaying the
captured pools at several budgets; method, numbers and limits are in
[`baselines/2026-11-04-response-budget.md`](baselines/2026-11-04-response-budget.md).

## Whole declarations

Windows cut from one long declaration now bring the whole declaration when one of
them qualifies; the replay behind it is in
[`baselines/2026-11-04-whole-declarations.md`](baselines/2026-11-04-whole-declarations.md).

## Hard set

Large repositories (1–7M tokens), Java, and a hand-written Go/Rust reliability set
(no-answer and false-premise questions); method, numbers and limits are in
[`baselines/2026-11-04-hard-set.md`](baselines/2026-11-04-hard-set.md).

## Verification

`npm run verify` includes tests for profile isolation and outcome equivalence, the
four real local cache scenarios, annotation consistency, evidence metrics and shared
dispatch limits. Existing Windows/Linux CI runs these offline. It does not enforce
machine-dependent timing thresholds or issue paid provider requests.
