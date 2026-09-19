# JevGrep design review and acceptance proposal

This document stress-tests the supplied project brief. It proposes contracts and validation work; it does not approve unresolved product choices or make claims about a particular provider implementation.

## Fixed scope from the brief

- An on-demand semantic search operation, available through a CLI and local MCP server backed by one engine.
- The agent asks a question and interprets the result. JevGrep selects evidence and does not diagnose bugs, edit code, or generate an explanatory answer.
- Jev evaluates all eligible fragments when the permitted scan can complete. No relevance prefilter based on text search, embeddings, or guessed important files.
- Results contain original source with provenance and fit a response budget.
- Remote inference, scan limits, exclusions, partial coverage, and selection omissions are explicit.
- JavaScript and TypeScript receive deliberate first-version support; other text must have a declared fallback policy.
- No conversation compaction, autonomous repository investigation, vector database, or hosted application in v1.

## Decisions requiring user preference

These decisions change product behavior or exposure. Recommendations remain proposals until accepted.

| Decision | Options | Recommendation and rationale |
| --- | --- | --- |
| Behavior when a requested scope cannot fit scan limits | Reject before dispatch; return a deterministic partial scan; require an explicit partial mode | Require explicit partial mode and otherwise reject at preflight when a complete scan is demonstrably impossible. This avoids spending on an arbitrary prefix that an agent might mistake for a comprehensive search. Estimates must be identified as estimates; runtime failures can still produce partial results. |
| Permission to send repository content remotely | Per-repository enablement; global enablement; approve every call | Explicit per-repository enablement with documented exclusions and visible provider configuration. Once enabled, ordinary calls within scope need no repeated confirmation. This makes the data movement understandable without obstructing normal use. |
| Treatment of ignored, untracked, and sensitive-looking files | Tracked-only; working tree with ignore rules; unrestricted text except explicit denies | Working tree with ignore rules, sensitive-file deny rules, and an explicit opt-in mechanism for additional permitted files. This supports searches of work in progress. Permission-denied files must remain forbidden regardless of query or requested include patterns. |
| Response budget meaning | Enforce a named tokenizer on the rendered result; use an approximate token estimate; use bytes only | Enforce a documented named tokenizer on the entire rendered application payload. If the intended host/model tokenizer cannot be determined, present a conservative documented estimate rather than claiming an exact host-context guarantee. The caller must know which guarantee it receives. |
| Value proposition to optimize first | Lowest total spend; shortest investigation latency; best task success under a fixed spend | Treat task success as a hard gate and seek lower combined cost on behavior-oriented investigations. Report latency separately; do not claim a general improvement if only one workload category benefits. User priorities should settle the economic target. |
| Repository/source freshness | Captured-source evidence; retry until current at response; require stable repository snapshot | Use captured-source evidence, with file content hashes and an explicit freshness indicator. Verify selected files once immediately before rendering and flag or omit changed ranges under a declared policy. Do not promise an atomic repository snapshot. User preference is needed if stale-but-traceable evidence must never be returned. |

Ordinary implementation decisions should not block the user: stable scan order, overlap merge mechanics, request identifiers, cache table layout, exact retry jitter, and test file organization are reversible engineering choices.

## Highest-priority contract risks

### P0: a small response can conceal an expensive scan

Separate limits are necessary for response tokens, new provider input, logical evaluations, API attempts, estimated money, concurrency, and elapsed time. A request must report effective limits after applying repository policy. The caller can reduce a policy cap but cannot increase it.

Decide what is measured for each limit. Raw source token count is not provider input: query text, instructions, paths, repeated shared state, serialization, and retry attempts may add input. If provider accounting is not known precisely before dispatch, reserve a conservative amount and label spend as estimated. A client cannot promise an exact maximum billed amount when provider pricing, token accounting, or ambiguous timeout billing prevents it. In that case the hard guarantee is on dispatchable units or a conservative reservation model, not the final invoice.

Before dispatching a batch, reserve its permitted budget atomically. Multiple concurrent workers must not each spend the same remaining allowance. A retry needs a new reservation unless an actual provider guarantee makes duplicate billing impossible. A timed-out request may already have incurred cost; do not release its reservation as though it was free. Cancellation stops new dispatch and requests cancellation of active work; it cannot promise to reverse provider charges already incurred.

For a stable, fully inventoried scope, preflight should reveal a fragment/source estimate. It must not be presented as an exact invoice. Inventory must itself have a resource bound so that a huge tree does not hang before the duration limit applies.

### P0: partial results can be misread as absence

Use two separate facts:

1. **Coverage:** whether every eligible fragment in the captured inventory received a valid decision, including exact cache hits.
2. **Selection:** whether any evidence survived thresholding, duplicate handling, and the response budget.

Neither implies that all useful evidence exists in the result. Suggested result dimensions are `coverage: complete | partial | unknown` and `outcome: selected | none_selected`, plus machine-readable reasons. An early inventory failure generally means coverage is unknown, because the total number of eligible fragments is not known.

Never assign zero relevance to provider failures, invalid responses, excluded files, or fragments left unscheduled. Distinguish these from evaluated negative decisions. The report should reconcile the inventory and outcomes; do not add cached fragments and newly evaluated fragments twice. A result containing only cache hits can still have complete coverage.

If strict full-scan mode rejects at preflight, return a typed error with the scope estimate and effective limit, without contacting the provider. If a run fails after some successful evaluations, return useful evidence with partial coverage when the request can still fit the response envelope. A caller can then narrow the scope or continue through ordinary tools.

### P0: authorization checks must precede reading and remote dispatch

Path string prefix checks are insufficient. Canonicalize the authorized root and candidate path, enforce path-segment containment, and define whether symlinks are allowed. Recommended v1 default: do not follow symlinks, junctions, or other reparse-point traversals. If permitted later, resolved targets must remain within the authorized root and loops must be detected.

Windows-specific fixtures should include drive-relative paths, rooted paths, UNC paths, device paths, alternate data stream syntax, mixed separators, case variants, and a root-prefix sibling such as `repo-other`. Reject unsupported forms explicitly. Root-relative output paths need one stable representation; OS-specific resolution should not turn two differently spelled scopes into duplicate inventory entries.

Prevent time-of-check/time-of-use escapes as far as the selected filesystem APIs allow. The content that is sent must come from the file identity that passed authorization. If this cannot be guaranteed against a concurrently hostile local filesystem, document the trust boundary rather than claiming a sandbox. Hard links also demonstrate why path containment alone is not a guarantee of content origin.

Repository text and comments cannot alter configuration, widen scope, ask the program to reveal files, change providers, or generate tool instructions. The provider response schema is data; it must never become a shell command or another tool request.

### P0: exact evidence must survive chunking, merging, and rendering

Keep immutable captured source and line/byte offsets. Do not reconstruct source from an AST printer, trim code, normalize whitespace, or insert explanatory text into a range labelled as original code. Define decoding support, BOM treatment, CRLF handling, and invalid-encoding behavior.

Recommended contract: returned code is an exact slice of the decoded captured file under the declared encoding. Hashes identify the captured original bytes. Line numbers are one-based and inclusive. If byte-exact reconstruction is required, the encoding/newline metadata must support it; avoid claiming byte identity merely because displayed text looks identical.

Merge only overlapping or adjacent ranges from the same captured file version. A merge must preserve the complete intervening source if a wider contiguous range is returned. Never join disjoint code into one fictitious line range. Re-evaluate the rendered size after every merge or selection change.

If a fragment is too large for a provider limit, split by deterministic source boundaries before evaluation. If a highly scored range cannot fit the response, either return a smaller independently traceable whole-line excerpt under a declared selection rule or omit it with a budget reason. Do not silently cut code mid-line or imply that a cropped excerpt contains an entire function.

### P0: the response budget includes the report

Budget the final serialized application payload: code, paths, ranges, scores, flags, errors, count fields, JSON escaping, and all metadata. Do not count only raw source. CLI and MCP may share a canonical payload even when a human CLI view renders it differently; the measured object must be stated.

Define a minimum budget capable of representing the fixed result envelope. Reject smaller requests before the scan; otherwise the engine can incur provider spend and then discover it cannot explain the result. Detailed exclusion paths or failed-fragment lists cannot grow without bound: return aggregate counts and bounded samples. The budget report itself participates in accounting, which requires final-render validation or a deliberately conservative reservation.

The MCP transport or host may add wrapper tokens outside application control. State that these are outside the application's token guarantee unless the exact integration provides reliable accounting. Do not duplicate a large response in both structured content and text content without accounting for what the host exposes.

### P1: stale or incorrectly shared scores break the semantics

Cache identity must cover the exact effective evaluation input and interpretation, not only source text. Include query, all evaluation instructions, provider/model/version identity where available, scoring schema/version, decoding/chunking behavior, and path/context whenever the path/context is supplied to the evaluator. A query normalization policy can only collapse forms deliberately declared equivalent; avoid hidden semantic normalization.

Identical file contents at two paths need separate evaluations when path text influences the prompt. A rename invalidates such a cached score. A changed query invalidates scores even when it asks about the same broad topic. A new threshold or response budget does not need to invalidate a raw valid score if the evaluator input is unchanged; selection can be rerun locally.

Cache only well-formed, complete decisions. Provider timeouts and malformed probabilities are not negative cache entries. Treat probabilities as model scores until calibration has been measured; raw values are not evidence of universal confidence calibration.

Cache retention should avoid persisting plaintext source when it is unnecessary. Scores and content fingerprints may be enough if source is captured afresh each run. Logs should not contain code or queries by default. Cache corruption is a recoverable miss, not an excuse to return unverified evidence.

### P1: duplicates can erase useful provenance

Three different operations need separate rules:

- **Inventory deduplication:** one file reached through overlapping scopes is inventoried once.
- **Overlap deduplication:** overlapping ranges in the same captured file version can be merged.
- **Cross-file content duplication:** identical-looking tests or vendored copies have different locations and can have different meaning.

Do not erase cross-file provenance under a generic duplicate flag. A conservative first version can retain distinct paths and report exact duplicates omitted by selection. If it emits one code body with alternate locations, count and budget those locations and preserve all identities. Fuzzy semantic deduplication and complementary-evidence ranking should remain later experiments.

### P1: deterministic partial scans introduce coverage bias

A stable alphabetical prefix is reproducible, but it can systematically omit important later directories. In partial mode, report the scheduling policy and the fact that the unevaluated tail was not tested. Do not call the prefix a representative sample. Overlapping scopes must not double-spend budget. Changing chunk size changes the fraction of a repository that fits, so benchmark manifests must pin chunking settings.

No relevance prefilter means lexical query matches cannot determine which fragments get provider evaluations. Authorized exclusions, decoding decisions, parser fallback, size limits, and deduplication remain permitted preparation, but all must be auditable and must not masquerade as semantic relevance decisions.

## Acceptance criteria

All deterministic tests below should use a scripted fake adapter so they verify engine behavior independently of model variability. Real-provider smoke tests establish integration separately.

| ID | Scenario | Required result |
| --- | --- | --- |
| AUTH-01 | Scope contains `..`, absolute external paths, root-prefix sibling, or unsupported Windows path form | Typed rejection before file content is sent externally; unauthorized paths are never read as search content. |
| AUTH-02 | Scope traverses a symlink, junction, or reparse point | Behavior matches the documented policy; default excluded traversal cannot reach outside the root. |
| AUTH-03 | An allowed file contains instructions requesting secrets or expanded scope | Inventory, permissions, configured provider, and filesystem operations are unchanged by that text. |
| AUTH-04 | A denied file is explicitly named alongside an allowed file | Denial wins; no denied bytes are in adapter requests, logs, cache source fields, or results. |
| INV-01 | Same file appears in multiple overlapping scopes and with supported case aliases | One captured file identity and one set of fragments are scheduled. |
| INV-02 | Binary, undecodable, generated, ignored, oversized, and unreadable files are present | Each has an explicit applicable disposition; counts reconcile without conflating exclusion with irrelevance. |
| CHUNK-01 | TS/JS fixtures contain functions, classes, imports, routes, top-level effects, JSX, comments, and syntax errors | Every supported eligible line is covered by a declared fragment policy or a documented excluded category; parser failures use a declared fallback or reported skip. |
| CHUNK-02 | One function or one line exceeds limits | Split or skip behavior is bounded, source-faithful, deterministic, and explicitly reported. |
| PROV-01 | Provider responds out of order or returns missing, extra, duplicate, invalid, or non-finite scores | Each valid score maps to the intended fragment ID exactly once; malformed items become explicit failures, not fabricated zero scores. |
| BUDGET-01 | Several batches approach the same remaining scan allowance concurrently | Reservations prevent dispatch beyond the hard cap. |
| BUDGET-02 | Provider times out, retries, and returns a rate-limit response | Attempts respect configured retry, concurrency, deadline, and reservation policies; unknown spend is identified. |
| BUDGET-03 | Full scan is demonstrably larger than a strict limit at preflight | No provider call occurs; caller receives a useful bounded typed error. |
| BUDGET-04 | Partial mode reaches a cap, cancellation, or deadline | New dispatch stops; completed evidence can be returned with correct partial/unknown coverage and reason. |
| BUDGET-05 | Response includes long paths, quotes, non-ASCII text, many exclusions, and JSON-sensitive source | The final rendered payload remains within its stated tokenizer/estimator guarantee. |
| BUDGET-06 | Requested budget is smaller than the minimal envelope | Validation fails before inventory/remote work; error size obeys the separate validation-error contract. |
| EVID-01 | Returned snippets include blank lines, Unicode, CRLF, quotes, and trailing spaces | Every excerpt equals the specified slice of captured decoded source, with correct inclusive line numbers and byte hash. |
| EVID-02 | Selected source changes during evaluation | No result silently combines old decisions with new source; declared freshness policy is applied and hashes remain truthful. |
| EVID-03 | Overlapping and disjoint ranges share one path | Only valid contiguous source ranges are merged; final budget is rechecked. |
| SELECT-01 | No score crosses threshold, or all qualified excerpts exceed remaining budget | `none_selected` is returned with the relevant reason and coverage facts; absence of behavior is never asserted. |
| SELECT-02 | Scores tie or provider completion order changes | Stable result ordering and stable selection for identical validated scores. |
| CACHE-01 | Repeat identical query/input with warm cache | Valid scores are reused; no new provider evaluation is needed; report separates cache hits from new evaluations. |
| CACHE-02 | Change query, instructions, provider/model identity, path supplied to Jev, or source content | A changed evaluation identity cannot reuse the old score. |
| CACHE-03 | Change only response budget or threshold | Raw score reuse is permitted; selected evidence is recomputed and newly budgeted. |
| CACHE-04 | Cache record is corrupt, incomplete, from an incompatible schema, or reflects an old provider failure | Treat as miss or discard safely; do not return fake evaluation success. |
| REPORT-01 | Fully evaluated inventory returns a small selection | Coverage is complete while response-budget omissions remain visible; completeness is never described as complete task understanding. |
| REPORT-02 | Directory traversal fails partway through inventory | Coverage is unknown unless the implementation has other proof of the full inventory; known counts do not pretend to be total scope counts. |
| PARITY-01 | Equivalent CLI and MCP requests run against identical captured input and scripted scores | The canonical result, limits, statuses, and selected ranges agree. Human rendering differences cannot change engine selection silently. |
| OPS-01 | MCP is operating over stdio while logs and errors are produced | Protocol output remains valid; diagnostics use the appropriate separate channel and are bounded. |

Additional invariants worth property-based testing are path containment, valid range arithmetic, exact source slicing, deterministic overlap merging, and final output size. These tests exercise broad inputs and failure boundaries rather than mirror the implementation.

## Benchmark proposal

### Questions to answer

1. Does a single search retrieve useful evidence under the requested response budget?
2. Does availability of JevGrep improve a real agent's whole investigation or coding task?
3. Which task categories benefit, and which should keep using ordinary search?
4. Are savings robust after including remote evaluation, failed scans, cache state, and retries?

Retrieval-only results cannot establish end-to-end task success. A smaller tool response cannot by itself establish lower total cost.

### Corpus and task strata

Use immutable repository revisions with reproducible working-tree overlays where needed. Include small and medium JS/TS projects and at least one repository large enough to exercise scan limits. Only use code that is authorized for the configured remote provider.

Stratify tasks before evaluation:

- Known symbol, path, or exact literal: control cases where ordinary search is expected to be strong.
- Behavioral search with weak lexical overlap between the natural-language question and implementation.
- Cross-file investigation with a second question emerging after the first result.
- Configuration, route wiring, top-level effects, migrations, and tests rather than only named functions.
- Duplicate-heavy code and near-identical tests.
- Negative or insufficient-evidence queries.
- Tight scope, broad scope, and deliberately constrained partial scans.
- Local modifications and stale-cache scenarios.

Keep protocol-adversarial fixtures separate from headline product-quality tasks. A tool can be correct on security and failure tests yet have weak retrieval value, or vice versa.

### Ground truth

For retrieval tasks, record a reviewed set of useful evidence spans and, where appropriate, several alternative acceptable evidence sets. Classify direct evidence, supporting evidence, and distracting evidence. Record why a span is useful. Do not assume there is exactly one correct file or that every solution must read the author's preferred path.

For end-to-end tasks, use hidden behavior checks and a review rubric for the intended change. Prevent regressions and prohibit deleting tests or weakening assertions as a means of passing. A task is successful only when the original behavior objective is satisfied. For diagnosis-only tasks, use a rubric for a supported explanation and correct source references rather than code tests alone.

Separate development tasks for threshold/ranker tuning from held-out evaluation tasks. Do not adjust thresholds based on held-out outcomes and continue to call the same set held out. Protect answer keys and reference patches from the working repository seen by the agent.

### Experimental arms

**A:** identical main agent configuration with its ordinary tools.

**B:** the same configuration and ordinary tools, with JevGrep available on demand and a concise tool description explaining its intended use.

The agent in B should choose whether to call JevGrep. Forcing a semantic scan on every task measures a different product. Record adoption rate and unsuccessful/non-beneficial invocations.

An optional **C**, run after the basic experiment, can compare the existing related implementation or a different selection algorithm if its license, setup, and behavior have been reviewed. It should not delay validating the core hypothesis. Advanced complementary selection is an ablation, not a hidden improvement folded into the baseline mid-study.

Pair tasks by revision and starting state. Randomize arm order and use multiple independent runs where agent/provider variability can change outcomes. Use identical allowed task limits and model settings. Pin or record provider/model versions, prompt version, engine revision, pricing assumptions, and chunking settings. Avoid shared cache warming between arms unless that is the explicit experimental condition.

### Measurements

| Family | Measures |
| --- | --- |
| Task quality | Success rate, regression rate, supported diagnosis correctness, and outcomes by task stratum. |
| Retrieval quality | Useful-evidence precision at the response budget, reference-span/evidence-set recall, no-result rate, false implication of absence, and selected-range provenance correctness. |
| Cost | Main-model input/output usage and cost, cached-input treatment where known, Jev input/output or billed units, failed-attempt spend, total combined spend, and cost per successful task. |
| Latency | Full task elapsed time, search latency, inventory/chunking time, provider queue and inference time where observable, and median plus tail latency. |
| Exploration | Number and type of search/read calls, bytes/tokens returned by those calls, repeated reads, and recovery searches after missing or misleading evidence. |
| Coverage | Eligible and evaluated fragments, cache hits, failed and unscheduled fragments, exclusion counts, complete/partial/unknown runs, and response-budget omissions. |
| Operation | Peak memory, maximum open files, cancellation response, concurrency, retries, invalid provider replies, and cache correctness. |

Recovery-search labeling needs a documented rubric; ordinary adaptive investigation is not automatically a failure. Count emitted tool text and actual agent input separately to avoid double-counting model context. Record unknown usage rather than treating it as zero.

Measure cold-cache and warm-cache conditions separately. Identical-query warm-cache wins are real for repeated use but do not represent novel-query performance. Report batch/concurrency settings because latency changes can trade off against cost and provider errors.

### Practical evaluation sequence

1. Run the deterministic contract suite with a fake adapter and adversarial filesystem fixtures.
2. Run a small authorized provider smoke corpus to validate actual request/response mapping and measurable limits.
3. Build a development retrieval set to choose a simple threshold and ranking/packing defaults.
4. Conduct a pilot of approximately 20–30 diverse paired tasks with repeated runs where practical. Use this to estimate variance, missing instrumentation, and failure categories; do not claim narrow success-rate equivalence from an underpowered pilot.
5. Agree on a primary metric, target workload, acceptable success-rate difference, and minimum economic gain before the held-out study. Choose a sufficient sample size from the pilot's variance and desired uncertainty.
6. Run the held-out A/B evaluation, preserve manifests and raw bounded telemetry, and publish strata as well as aggregate results.
7. Decide whether to keep, narrow, revise, or stop the product. If the result only helps behavioral investigations in bounded scopes, document that supported niche explicitly.

### Proposed gates

**Correctness gate:** all P0 contract criteria pass. Zero unauthorized content dispatches and zero silently fabricated source ranges are tolerated in the test suite.

**Integration gate:** equivalent CLI and MCP calls use the same engine behavior; real-provider failures and invalid replies produce truthful statuses; accounting bounds are demonstrated using the provider behavior actually observed.

**Product gate:** held-out task success meets the agreed non-inferiority criterion, and the agreed primary efficiency metric improves on the target task stratum after total provider/main-agent costs are included. The exact tolerance and improvement target require user preference and pilot evidence.

**Claims gate:** no general claim of faster, cheaper, optimal, exhaustive, or fully calibrated search unless its precise meaning and supporting measurement are stated. Complete evaluation coverage is the strongest search-completeness claim the engine can directly prove.

## Recommended implementation-order implications

Write request/result schemas and budget/status definitions before chunking or provider integration. Build the fake adapter and provenance-preserving pipeline early, so budget and failure tests do not depend on a live service. Resolve provider request identity and accounting behavior in a small integration spike before committing to cost guarantees. Add CLI first as a thin wrapper over the engine, then MCP, and finally collect agent-level benchmark evidence. Relevance quality tuning belongs after correctness and instrumentation are trustworthy.

## Open questions for the main specification

1. Which initial product priority should decide a tradeoff between lower cost and lower latency when task success is unchanged?
2. Should a broad request exceeding a cap fail before dispatch by default, or is deterministic partial coverage the preferred everyday behavior?
3. Should changed selected files cause omission with a stale-source report, or may captured-source excerpts be returned with explicit hashes and a stale flag?
4. Which additional file categories, if any, should be included by default beyond JS/TS and directly relevant text configuration under repository ignore rules?
5. Is exact accounting against a named tokenizer required for v1, or is an explicitly conservative estimate acceptable?

The specification can record recommendations for these questions immediately. It should not label user preferences as settled until the user has answered or explicitly accepted the defaults.
