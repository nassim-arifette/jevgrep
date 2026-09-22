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

## Verification

`npm run verify` includes tests for profile isolation and outcome equivalence, the
four real local cache scenarios, annotation consistency, evidence metrics and shared
dispatch limits. Existing Windows/Linux CI runs these offline. It does not enforce
machine-dependent timing thresholds or issue paid provider requests.
