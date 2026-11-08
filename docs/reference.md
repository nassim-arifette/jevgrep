# JevGrep reference

Details behind the [README](../README.md): providers, output contract, caching, request batching and development.
For installation, limits and troubleshooting, see the [installation guide](install-guide.md).

## Providers

| Provider          | Setup                                       | Model                 |
| ----------------- | ------------------------------------------- | --------------------- |
| TypeSafe AI       | `jevgrep init --global --provider typesafe` | `jev-1.13.0` (pinned) |
| Vercel AI Gateway | `jevgrep init --global --provider vercel`   | `typesafe-ai/jev`     |
| OpenRouter        | `jevgrep init --global --provider openrouter` | `typesafe/jev-1.13` |
| Cloudflare Workers AI | `jevgrep init --global --provider cloudflare` | `typesafe/jev` |
| LiteLLM           | `jevgrep init --global --provider litellm` | `jev-1.13.0` |
| Portkey           | `jevgrep init --global --provider portkey` | `@<integration-slug>/jev-1.13.0` |

The TypeSafe transport follows the documented System One HTTP contract and is covered
with simulated responses. It has not been tested against a real account in this project.
Vercel AI Gateway has been checked on a small authentication example, including a
repeat search served entirely from the score cache.

OpenRouter uses its alpha Decisions endpoint, `POST https://openrouter.ai/api/alpha/decisions`,
with Bearer authentication and structured Noul questions. The adapter supplies both
`true` and `false` criteria, reads `answers[id].noul`, `usage.input_tokens`,
`usage.output_tokens` and the response `id`, and disables provider fallback.
Its request and response handling were reviewed against the
[official OpenRouter OpenAPI specification](https://openrouter.ai/openapi.json)
(`DecisionsRequest`, `DecisionsNoulQuestion`, `DecisionsResponse`) on 2026-09-20.
No live OpenRouter request or automated test was run for this integration.
The alpha API may change. See the [Jev model page](https://openrouter.ai/typesafe/jev-1.13)
and [OpenRouter configuration example](examples/jevgrep.openrouter.config.json).

To switch an existing global and project profile to Vercel:

```bash
jevgrep init --global --provider vercel
jevgrep init --provider vercel
```

Use `--provider openrouter` in both commands to switch to OpenRouter.
The same applies to `cloudflare`, `litellm` and `portkey`. Their transports follow the
official Jev contracts, with offline HTTP, configuration, init, batching and cache tests;
no live inference request was made. See [setup, credentials and upstream prerequisites](install-guide.md#cloudflare-litellm-and-portkey).

| Adapter | POST endpoint | Payload / credential |
| --- | --- | --- |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/run` | `{ model, input: { state, questions } }`, Bearer Cloudflare token |
| `litellm` | `<trusted-proxy-base>/typesafe/v1/systemone` | `{ model, state, questions }`, Bearer LiteLLM virtual key |
| `portkey` | `https://api.portkey.ai/v1/decisions` | `{ model: "@<slug>/jev-1.13.0", state, questions }`, `x-portkey-api-key` |

LiteLLM and Portkey require a TypeSafe key stored on the gateway. JevGrep does not
configure gateway-side retention, retries, fallback or pricing; operators must review
those settings. New profiles have no inferred rate card. All three adapters preserve
unknown usage as unknown and reject malformed or duplicate answers without discarding
valid neighbors. Cloudflare's optional `{ success, result }` response wrapper is checked
before the common Jev response normalization, including duplicate keys inside `result`.

## Results and exit codes

Human-readable output is the default. Pass `--json` for the validated response contract.
The result includes coverage information, exclusions, stop reasons and exact excerpts,
so an empty or partial result is not presented as proof that code does not exist.

| Code  | Meaning                                                      |
| ----- | ------------------------------------------------------------ |
| `0`   | complete result                                              |
| `2`   | invalid request, configuration problem or rejected preflight |
| `3`   | partial result                                               |
| `4`   | fatal runtime failure                                        |
| `130` | interrupted                                                  |

Results go to stdout. Diagnostics and measurements go to stderr.

## Cache

JevGrep caches provider scores outside the repository, independently for each question
and fragment. Changing another fragment does not invalidate an unchanged score.
Provider, endpoint, model, query, source, location, criterion and layout remain part
of the identity. Only misses are grouped into requests.

New TypeSafe direct profiles pin `jev-1.13.0` and use the configured cache TTL (seven
days by default). Vercel's `typesafe-ai/jev` and OpenRouter's `typesafe/jev-1.13`
use the conservative rolling policy: scores can be reused for up to 15 minutes.
OpenRouter may resolve the requested model to a dated revision in its response;
the version alias is not treated as an immutable cache identity. Existing direct profiles
using `jev-latest` or `jev-preview` use the same short-lived policy.
Cloudflare's `typesafe/jev`, LiteLLM and Portkey use that same maximum 15-minute policy,
even for a versioned model on a gateway: the upstream configuration is operator-owned.
The Cloudflare account URL, LiteLLM proxy URL and Portkey integration-prefixed model
are part of the cache identity. A mismatched returned revision is never cached.

Rolling reuse can briefly serve a score from an earlier model revision. `doctor`
shows this policy and its effective TTL. Set `cache.rolling_ttl_seconds` to `0` to
disable it, or to an integer from `1` to `900` to shorten it. `cache.enabled: false`
disables all score and preparation reuse. Existing profiles do not need to be recreated.

File preparation is cached separately, by file content. Every search still inventories,
reads and hashes each eligible file, so ignore rules, deny globs and authorization always
apply; only the content checks, line token counts and fragment boundaries of unchanged
bytes are reused. Each cache is bounded by `cache.max_bytes`.

Clear both caches for the current project with:

```bash
jevgrep cache clear
```

Cached entries contain scores, identities, hashes, line numbers, token counts and
structural labels such as function names, not source text, questions or credentials.

## Request batching

Fragments remain small enough to return precise excerpts. Requests pack fragments by
the estimated tokens in the complete serialized payload, including the query, criteria
and metadata.

| Transport         | Aggregate ceiling used                    | Target with tokenizer headroom |
| ----------------- | ----------------------------------------- | ------------------------------ |
| TypeSafe direct   | 64,000 tokens                             | 44,800 reference tokens        |
| Vercel AI Gateway | 32,000 tokens (conservative local policy) | 22,400 reference tokens        |
| OpenRouter        | 32,000 tokens (conservative local policy) | 22,400 reference tokens        |
| Cloudflare / LiteLLM / Portkey | 32,000 tokens (conservative local policy) | 22,400 reference tokens |

TypeSafe documents 64k total and 32k for shared state plus one question. Gateway and
OpenRouter advertise a 32k context; using it as an aggregate ceiling is conservative,
not a claim that they document the same total-question limit. The new routes use the
same conservative ceiling, not a promise about gateway or upstream capacity. All paths keep
30% headroom because the provider tokenizer is not public, and locally limit each
request to 64 questions and 256 KiB. These last two limits are application safeguards.
See [TypeSafe model limits](https://docs.typesafe.ai/models) and the
[Gateway model catalog](https://ai-gateway.vercel.sh/v1/models) and
[OpenRouter Jev model page](https://openrouter.ai/typesafe/jev-1.13).

`inspect` and search planning use the same serializer and token estimator; `inspect`
uses a sample query, so its estimate can differ from an actual search. Estimates are
not provider billing. `inspect` also runs the search preflight against every enabled
`scan_caps` entry and lists the caps a complete cold search (no cache hits) would
exceed; such a search is refused before any provider request unless partial scans are
allowed. File preparation still runs on every search, reusing cached work
only for unchanged file contents: there is no persistent repository index.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

Run the complete local verification gate with:

```bash
npm run verify
```

The test suite is offline and does not use provider credentials. Run `npm run bench`
for the local performance baseline, or `npm run bench:retrieval -- --validate-only`
to check the annotated retrieval pilot without network access. Real retrieval runs
use an explicit provider configuration. See [benchmark commands and interpretation](../benchmarks/README.md).
CI verifies benchmark correctness without enforcing machine-dependent timing limits.
