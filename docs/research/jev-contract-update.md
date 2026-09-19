# Jev contract update for JG-004

Checked **2026-09-19** against official documentation, npm package metadata, and the official JavaScript SDK source. This supplements [the initial research](jev.md). **No provider call was made; every account-specific or live behavior below remains unverified. JG-004 and the JG-005 experiment remain open.**

## Reproducible source baseline

The npm registry currently marks **`@typesafe-ai/sdk@0.6.0`** as latest, published `2026-09-15T18:17:19.263Z`, with Node `>=20`. The official `v0.6.0` tag resolves to commit **`66880ccded6cb642dc1809620c2b108c33730214`**. [Registry metadata](https://registry.npmjs.org/@typesafe-ai%2Fsdk), [tag reference](https://api.github.com/repos/typesafe-ai/typesafe-sdk-js/git/ref/tags/v0.6.0), [package source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/package.json).

Local inspection found Node **24.15.0**, npm **11.12.1**, and no provider SDK dependency in [package.json](../../package.json). Its supported runtime is Node 24. The later loopback qualification is recorded separately in the evidence report below. Read-only reproduction commands:

```powershell
node --version
npm --version
npm view @typesafe-ai/sdk dist-tags version engines dist.integrity --json
```

## Verified API surface and documented limits

| Area | Source-backed fact and consequence |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, JSON containing `state`, `model`, and keyed `questions`. Question keys correlate answers and are not model input. [HTTP API](https://docs.typesafe.ai/api) |
| Noul | `noul(instructions, criteria?)` builds a question. A returned `{ type: "noul", noul: number }` represents affirmative probability in `[0,1]`, with no separate confidence. Use explicit instructions even though SDK types allow omission/null. [Noul](https://docs.typesafe.ai/primitives/noul), [builder source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/questions.ts) |
| Model identity | Published version: `jev-1.13.0`; `jev-latest` and `jev-preview` currently point there. The model page promises a versioned response ID, but HTTP examples return the alias. Record requested and returned strings separately; actual account response is **unverified**. [Models](https://docs.typesafe.ai/models), [HTTP examples](https://docs.typesafe.ai/api) |
| Usage | `SystemOneResult` contains `model`, keyed `answers`, and `usage.input_tokens` / `usage.output_tokens`. It has no monetary-cost field. Runtime validation remains necessary. Missing usage is unknown, never zero. [Result types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/types.ts) |
| Limits | Published: 64k tokens for state plus all questions; 32k for state plus the longest question; 250,000 tokens/second and 1,200 requests/minute, changeable without notice. Actual account limits and accepted boundary sizes are **unverified**. [Models](https://docs.typesafe.ai/models) |
| Pricing | Published input rate: **USD 0.042 / million tokens**, output free. A multiplication using this dated rate is an estimate. Account pricing, charging on failures/abort, invoice rounding and idempotent billing are **unverified**. [Models](https://docs.typesafe.ai/models) |

The primitives page gives no separate numeric question-count cap, but still describes an approximately 32k total budget, inconsistent with the more specific model page. Use conservative request sizes pending live verification. Independence is documented for questions sharing unchanged state; this does not settle JG-005 layout quality or cache reuse. [Primitives](https://docs.typesafe.ai/primitives).

No public tokenizer/count endpoint or billing-idempotency contract was located in the [documentation index](https://docs.typesafe.ai/llms.txt), HTTP reference or inspected SDK. This is a search result, not proof of absence.

## Transport controls

- **Disable retries with `retry: { maxRetries: 0 }`, not a top-level `maxRetries`.** Defaults are two retries after the first attempt, HTTP 408/429/5xx plus connection errors/timeouts, 500ms initial backoff, 5s cap, jitter and retry headers. The default timeout is 10s **per attempt**. [Retry implementation](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/retry.ts).
- **Set `logLevel: "off"` explicitly.** This overrides `TYPESAFE_LOG_LEVEL`; debug logging includes unredacted bodies. Also pin `baseURL` and `defaultModel` explicitly to override ambient provider settings. [Configuration types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/types.ts), [logging](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/logging.ts), [environment](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/env.ts).
- **`systemOne(request, { signal })` accepts `AbortSignal`.** Source propagates cancellation through fetch, body delivery and retry waiting, and reports `APIUserAbortError`. Local process survival and cancellation now pass the loopback qualification; actual provider cancellation remains **untested**. [Client source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/client.ts).
- **`.withResponse()` returns `{ data, response, requestId }`**; the ID comes from `x-typesafe-request-id` and may be absent. `.asResponse()` exposes the body for a caller-owned parser. [Promise implementation](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/api-promise.ts).
- **Production adapter implication:** the SDK buffers the full body without an exposed byte cap, parses using `JSON.parse`, and casts its result. Duplicate JSON keys have therefore disappeared before ordinary answer validation. Preserve raw text and use duplicate-aware validation, or a bounded HTTP transport, when implementing the strict contract. This is an inference from the [client parser/buffering code](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/client.ts), not an observed provider defect.
- SDK errors retain provider bodies and may incorporate their contents in `message`; do not serialize whole errors into application logs. Select bounded status/class/request-ID metadata. [Error implementation](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/errors.ts).

## Executable probe and local qualification

The separate [experiment package](../../experiments/jev-contract/README.md) now implements the pinned SDK probe and a native-fetch comparison. Fourteen loopback child-process cases passed on Node 24.15.0; [the evidence report](../reports/jg-004-offline-sdk.md) records commands, observations and remaining gates. The live probe was not dispatched because no credential is configured.

Remaining JG-004 evidence: observed authentication, account model/usage, capacity boundaries and provider-side cancellation/billing. JG-005 still needs its predeclared A/B/C comparison at batch sizes 1/8/16; the two-question probe cannot close it.
