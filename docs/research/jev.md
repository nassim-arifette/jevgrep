# Jev API and jevwire research for JevGrep

Research date: **2026-09-19**. Sources: TypeSafe documentation, TypeSafe SDK source, and the upstream jevwire repository. This is a dated evidence note, not an account-specific service agreement. No paid inference was invoked and no local project content was sent to Jev.

## Findings that affect the design

- The proposed typed relevance operation is supported: Noul gives the probability of an affirmative answer, with no separate confidence field. Independent yes/no questions allow several fragments to score highly. [Noul](https://docs.typesafe.ai/primitives/noul)
- TypeScript and Python both have official SDKs. TypeScript is a reasonable implementation recommendation because the existing jevwire code is TypeScript and JevGrep initially targets JS/TS repositories; that is an engineering choice, not a Jev API requirement. [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), [Python SDK](https://docs.typesafe.ai/sdk/python), [jevwire package](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/package.json)
- The brief's query-only shared state with one excerpt inside each question is representable by the API schema, but its retrieval accuracy and billing should be tested before treating it as a proven design. Official guidance places content in state; the official reranking example evaluates one query/candidate pair per call. [State](https://docs.typesafe.ai/concepts/state), [API](https://docs.typesafe.ai/api), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
- `jev_rank` is a tool inside **Brainwires/jevwire**, not a separate repository named `jevwire/jev_rank`. Its existing behavior is a useful baseline, but does not provide JevGrep's exact-excerpt response or response-token packing. [Pinned rank implementation](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/tools/rank.ts)
- The available evidence supports local hard limits on attempts, bytes, concurrency, and elapsed scheduling time. It does **not** establish an enforceable, exact provider-dollar cap, a public Jev tokenizer, or billing idempotency. Token and dollar estimates must be labelled estimates; unresolved attempts must retain unknown usage.

## API contract

The documented evaluation route is `POST https://api.typesafe.ai/v1/systemone`, using bearer authentication and JSON. Its required fields are `state`, `model`, and a map of `questions`. State and question instructions can be strings, objects, or arrays. Question IDs are returned as correlation keys but are not model input, so all semantic information must appear in state, instructions, or criteria. The response includes `model`, keyed `answers`, and `usage.input_tokens` / `usage.output_tokens`. [HTTP API reference](https://docs.typesafe.ai/api)

A Noul question has `type: "noul"`, instructions, and optional affirmative/negative criteria. Its answer has `type: "noul"` and `noul` in `[0, 1]`. A value near 0.5 represents similar yes/no probability; it is not a medium relevance grade or a separate confidence score. JevGrep should call the field `relevance_probability` and preserve the raw value. Threshold selection remains an empirical product decision. [Noul](https://docs.typesafe.ai/primitives/noul)

Recommended response checks are JevGrep requirements: verify every requested key, type, finite bounded probability, model identity, and nonnegative integer usage. Never turn missing, malformed, or failed evaluations into a zero relevance score. TypeScript declarations alone do not establish runtime validity: the official SDK's generic response parse returns JSON under a declared result type. [SDK client v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), [SDK result types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)

## Batching, shared state, and caching

TypeSafe documents that questions run independently against the same state. Adding or removing questions does not change the other answers, and an answer is not hidden context for another question. Additional questions incur their additional input tokens. The same page says question count is bounded by the shared token budget, without a separate numeric question-count maximum. It also still describes that budget as approximately 32k, whereas the model specification below gives two distinct limits. [Primitives](https://docs.typesafe.ai/primitives)

At this research date, the model page lists `jev-1.13.0`, `jev-latest` and `jev-preview`. Both aliases currently resolve to that version. It specifies:

| Property | Published value |
|---|---|
| Total request context | 64k tokens: state plus all questions |
| Per-question context | 32k tokens: state plus the longest question |
| Input price | USD 0.042 per million tokens |
| Output price | Free |
| Rate limits | 250,000 tokens/second and 1,200 requests/minute; subject to change |

The same page says state is ingested once, returned `model` identifies the version that answered, and pinned version IDs can be accepted even when `/v1/models` only lists aliases. Pin a version for tuned thresholds and reproducible caches. These are published values, not verified limits for the user's account. [Models](https://docs.typesafe.ai/models)

There is a documentation inconsistency: some HTTP examples return `model: "jev-latest"`, while the model page promises a versioned response ID. JevGrep should record requested and returned IDs separately and must not invent a resolved version. A live synthetic contract probe should verify the account's response before enabling long-lived cache reuse. [HTTP examples](https://docs.typesafe.ai/api)

Three layouts deserve a controlled comparison:

| Layout | Data placement | What to test |
|---|---|---|
| Brief's proposed layout | Shared query/criteria; each question contains its own path and excerpt | Throughput, relevance quality, response independence, and token accounting |
| Single-excerpt baseline | Query and one excerpt in state; one standard Noul question | Retrieval quality with minimal distracting context |
| Existing jevwire baseline | Query plus multiple excerpts in shared state; one Noul referencing each excerpt | Effect of batch width and unrelated neighboring excerpts |

The first layout follows the brief and avoids embedding unrelated excerpts in shared state. Its merits are a hypothesis. The second follows the official reranking example. The third is implemented upstream. Use identical excerpts, rubrics, and pinned model; vary candidate order, batch size, and distractors. Do not copy legal-retrieval benchmark gains into code-search product claims. [Reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [jevwire rank](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/tools/rank.ts)

**Cache implication:** question independence does not mean independence from changed state. When a batch's candidate list lives in state, adding another excerpt changes a model input. Initially key the complete ordered evaluation request, provider identity, pinned/returned model identity, and evaluator version. A fragment-level cache is a later optimization after the selected layout's invariance is validated. Include every model-visible path or contextual wrapper; identical code under a different model-visible path is not the same evaluation.

## Usage, spending, retries, and cancellation

The official JavaScript result interface contains token counts, not a guaranteed monetary `cost` property. A dollar figure calculated from reported input usage and a dated rate card is a derived charge estimate, not an invoice. Preserve raw reported usage separately from estimated input reservations and derived dollars. If an undocumented cost field appears, its unit and meaning need validation before use. [SDK types v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)

No public tokenizer or token-count endpoint was located in the official documentation index, API reference, SDK surface, or the source examined. This is a search limitation, not proof that none exists privately. jevwire estimates tokens using character count divided by 3.5; that is its heuristic, not a mathematical upper bound for arbitrary code or Unicode. [Documentation index](https://docs.typesafe.ai/llms.txt), [jevwire budgeting](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/decision/budget.ts)

The HTTP documentation identifies authentication and validation errors, plus retryable rate-limit/overload responses. The JS SDK has broader defaults: two retries after the first attempt; retry HTTP 408, 429, and 5xx, connection failures, and timeouts; 500ms initial backoff, 5s cap, jitter, and retry headers. Its default timeout is **10 seconds per attempt**, not a whole-search deadline. [Retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy), [SDK retry source v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts)

The inspected SDK transport has a retry-count header and exposes a provider request ID, but no documented idempotency-key or duplicate-billing protection contract was found. An interrupted response can follow successful provider evaluation, so resubmitting may incur another evaluation and charge. Likewise, no source examined guarantees zero charges for all error statuses. Do not infer billing semantics from HTTP status alone. [SDK transport](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), [request ID access](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/api-promise.ts)

Recommended scheduler behavior:

1. Disable nested SDK retries (`maxRetries: 0`) and own each dispatch in the engine.
2. Reserve estimated request cost atomically before dispatch, including repeated query/rubric/wrapper text. Count retries as new attempts.
3. Apply hard aggregate byte and attempt limits, a concurrency limit, and a whole-search deadline. Enforce provider context estimates conservatively with headroom.
4. Reconcile reservations with successful reported usage. Retain reservations and mark usage unknown for potentially submitted attempts without trustworthy usage.
5. Retry recognized transient responses only within remaining reservation, attempt, and deadline limits. Surface partial coverage if work stops.
6. Do not retry ambiguous transport failures automatically by default in a cost-controlled experimental open-source MVP. An explicit configured policy may enable them with the same attempt accounting.
7. If a strict invoice-level spend ceiling is required, require a verified provider/account spending control or clarified billing contract. Local estimates alone cannot establish that promise.

The SDK supports caller cancellation and `withResponse()` exposes `x-typesafe-request-id`. Debug logging includes full request bodies, including state and questions. Configure logging explicitly to omit content and credentials; do not rely on environment-selected debug settings. [SDK client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), [API promise](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/api-promise.ts)

An open first-hand compatibility report describes process termination during handled cancellation with SDK 0.6.0 on specific Node 20/22 builds, with the same reproduction passing on Node 24. This research did not reproduce it; it is a reason to include a subprocess cancellation test on the chosen runtime, not a proven failure of every Node 20/22 environment. [Upstream SDK issue 2](https://github.com/typesafe-ai/typesafe-sdk-js/issues/2)

## SDK and language choice

| Route | Verified facts | JevGrep implication |
|---|---|---|
| Official JS/TS SDK | `@typesafe-ai/sdk`; Node >=20; `TypeSafeClient.systemOne`; ESM, CommonJS, type declarations; `TYPESAFE_API_KEY` | Natural fit for a TS implementation; wrap transport and validate replies |
| Official Python SDK | `typesafe-sdk`; sync and async clients; Python >=3.10 | Feasible alternative if Python is the user's preference |
| Direct HTTP | Small request surface with bearer auth | Avoids SDK coupling, but retries, cancellation, validation and errors become project code |

Sources: [JS guide](https://docs.typesafe.ai/sdk/javascript), [Python guide](https://docs.typesafe.ai/sdk/python), [Python package metadata](https://github.com/typesafe-ai/typesafe-sdk-python/blob/main/pyproject.toml), [HTTP reference](https://docs.typesafe.ai/api).

Recommendation: TypeScript with one narrow provider adapter and a runtime validated response schema. Keep the engine independent of SDK types. Start with the official SDK with its retries disabled, or use a small direct HTTP adapter if controlling each attempt and response byte limit is simpler. Resolve this during the provider-contract spike; neither route should dictate inventory, chunking, selection, or cache semantics.

## Privacy and model limitations

The privacy policy covers the API and says input is not used to train or fine-tune models. It describes collection of input, possible service-provider disclosure, and hosting in the United States. Its retention period is purpose-based rather than a fixed number of days. This does not support a claim of ordinary-account zero retention. [Privacy policy, updated 2025-11-19](https://typesafe.ai/legal/privacy-policy)

The legal documentation offers zero data retention for enterprise customers. The DPA's duration provision also uses purpose-based retention rather than a fixed day count. The account's actual agreement and any enterprise ZDR arrangement must be verified before representing these as active protections. [Legal overview](https://docs.typesafe.ai/legal), [DPA, updated 2026-04-24](https://typesafe.ai/legal/data-processing)

The provider explicitly documents susceptibility to adversarial content, unrelated shared context, literal phrasing, and indirection; it recommends keeping arithmetic and counting in code. JevGrep must therefore enforce root authorization, exclusions, budgets, references, and output packing deterministically. Prompt instructions can describe source text as data but cannot replace those controls. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## jevwire reuse assessment

Snapshot inspected: commit **`fabe7e79252b415278cd4b42355e63106fb5af80`**, committed 2026-09-18; `package.json` version **0.5.2**. The package targets Node >=20 and exposes an embeddable library, an MCP server, and other tools/hooks beyond ranking. [Package metadata](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/package.json), [public exports](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/lib.ts)

`jev_rank` accepts exactly one of candidates, paths, or glob; creates one Noul per candidate plus an aggregate relevance question; sends candidate texts in shared state; batches by estimated context and at most 16 candidates; sorts by probability with input-order ties; supports file ranking by best chunk; returns ranked references without source text. Its source comments report poorer discrimination with much larger batches on its own repository. Those are upstream measurements, not results reproduced here. [Rank source](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/tools/rank.ts)

Its file layer uses 60-line chunks with five-line overlap, subdivides by a 6,000-character cap, limits files to 512 KiB and glob matches to 1,000, and applies root/sensitive-file/binary/generated-output checks. Its scan cost limit is based on token estimates. These are implementation choices, not provider limits or language-aware parsing. [File source](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/files/index.ts)

The default adapter rejects missing answers and mismatched answer types. However, `runRank` itself has a missing-score fallback to zero when used with other adapters; the default adapter also substitutes zero for absent usage and falls back to the requested model name. JevGrep should not inherit those fallback semantics. No inference is made here that ordinary stock jevwire silently accepts missing answers: its default adapter checks them first. [Adapter source](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/jev/client.ts), [rank source](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/src/tools/rank.ts)

The repository uses MIT: reuse, modification, and redistribution are allowed subject to retaining the copyright and permission notice for copied/substantial portions. Preserve upstream attribution for any adapted files. [Pinned license](https://github.com/Brainwires/jevwire/blob/fabe7e79252b415278cd4b42355e63106fb5af80/LICENSE)

Recommendation: use jevwire as an attributed baseline and inspect selected transport/budget utilities, rather than depending on the whole package as JevGrep's engine. Its extra hooks, shared-state layout, reference-only output, and different accounting contract otherwise become constraints on the proposed product. This is a project design recommendation, not an upstream quality verdict.

## Unresolved verification work

- **Account access:** whether the user has a working direct TypeSafe key, actual account limits, and applicable pricing/privacy agreement.
- **Request semantics:** synthetic tests for excerpt-per-question layout, batching invariance, missing/malformed answer handling, returned model ID, and actual usage counts.
- **Tokenizer:** whether TypeSafe offers a supported tokenizer or count endpoint outside the public sources examined.
- **Billing:** exact inclusion of serialization/wrapper overhead, rejected request charging, ambiguous attempts, and idempotency support.
- **Large-scope feasibility:** measured wall-clock latency, total inputs, and retrieval quality on representative repositories up to the user's intended size. Lines of code alone do not predict tokens or request count.
- **Retrieval usefulness:** calibrated threshold and response packing quality on labeled code tasks; no documentation establishes JevGrep's expected recall or end-to-end task improvement.
- **Runtime:** chosen supported Node release and a subprocess test for cancellation during response-body delivery.

These unknowns justify a small contract and retrieval experiment before substantial engine work. They do not require postponing the deterministic inventory, scope, chunking, result schema, fixture suite, or local-only dry-run design.
