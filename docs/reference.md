# JevGrep reference

Details behind the [README](../README.md): providers, output contract, caching, request batching and development.
For installation, limits and troubleshooting, see the [installation guide](install-guide.md).

## Providers

| Provider          | Setup                                       | Model                 |
| ----------------- | ------------------------------------------- | --------------------- |
| TypeSafe AI       | `jevgrep init --global --provider typesafe` | `jev-1.13.0` (pinned) |
| Vercel AI Gateway | `jevgrep init --global --provider vercel`   | `typesafe-ai/jev`     |
| OpenRouter        | `jevgrep init --global --provider openrouter` | `typesafe/jev-1.13` |

Validation evidence as of 2026-11-11 (recorded repository runs, not fresh live checks):

| Provider | Latest recorded evidence | Scope of validation |
|---|---|---|
| TypeSafe direct | 2026-11-04 [judge comparison](../benchmarks/baselines/2026-11-04-judge-comparison.md) and [Go/Rust comparison](../benchmarks/baselines/2026-11-04-codegraph-comparison.md) | Live `jev-1.13.0` / `jev-1.14.0` benchmark runs; offline transport and error tests |
| Vercel AI Gateway | 2026-11-04 [hard-set report](../benchmarks/baselines/2026-11-04-hard-set.md) | Recorded large-repository searches; offline adapter and cache tests |
| OpenRouter | 2026-09-20 integration review | Documented alpha contract and offline transport tests; no recorded live account run |

OpenRouter uses its alpha Decisions endpoint, `POST https://openrouter.ai/api/alpha/decisions`,
with Bearer authentication and structured Noul questions. The adapter supplies both
`true` and `false` criteria, reads `answers[id].noul`, `usage.input_tokens`,
`usage.output_tokens` and the response `id`, and disables provider fallback.
Its request and response handling were reviewed against the
[official OpenRouter OpenAPI specification](https://openrouter.ai/openapi.json)
(`DecisionsRequest`, `DecisionsNoulQuestion`, `DecisionsResponse`) on 2026-09-20.
No live OpenRouter request is recorded. Offline tests cover prepared-body transport.
The alpha API may change. See the [Jev model page](https://openrouter.ai/typesafe/jev-1.13)
and [OpenRouter configuration example](examples/jevgrep.openrouter.config.json).

To switch an existing global and project profile to Vercel:

```bash
jevgrep init --global --provider vercel
jevgrep init --provider vercel
```

Use `--provider openrouter` in both commands to switch to OpenRouter. Repeating
project `init` updates disclosure consent and preserves tuned settings. A provider
change replaces provider defaults; repeating the same provider preserves its model
and pricing settings. Without `--provider`, the existing project's choice takes
precedence over the global default.

Replace a stored provider key with `jevgrep init --global --replace-key` (optionally
`--provider <name>`). Key replacement always prompts, hides interactive terminal
input, and retains other providers' keys. It does not change project consent.
Environment variables continue to override stored keys.

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

Rolling reuse can briefly serve a score from an earlier model revision. `doctor`
shows this policy and its effective TTL. Set `cache.rolling_ttl_seconds` to `0` to
disable it, or to an integer from `1` to `900` to shorten it. `cache.enabled: false`
disables all score and preparation reuse. Existing profiles do not need to be recreated.

File preparation is cached separately, by file content. Every search still inventories,
reads and hashes each eligible file, so ignore rules, deny globs and authorization always
apply; only the content checks, line token counts and fragment boundaries of unchanged
bytes are reused. Each disk cache is bounded separately by `cache.max_bytes`.
The preparation cache also uses approximate byte-weighted LRU limits of 64 MiB
resident entries and 16 MiB pending persistence. A long-lived search engine retains
up to 16 MiB of score entries, checking TTL, model policy and cache authorization
before reuse. These heap budgets are independent of disk limits and are not a cap
on total process RSS or source snapshots. Cache statistics expose resident/dirty
bytes, memory evictions, score disk reads and memory hits.

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

TypeSafe documents 64k total and 32k for shared state plus one question. Gateway and
OpenRouter advertise a 32k context; using it as an aggregate ceiling is conservative,
not a claim that they document the same total-question limit. All three paths keep
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

## MCP contracts and multiple questions

The tools advertise JSON Schemas generated from the runtime contracts. Excerpts
carry exact source in `code`, with `path`, `start_line`, `end_line`, `score` and
`file_sha256`. `structuredContent` and the JSON text block describe the same result.

`semantic_search_code_many` accepts an object with 1–16 fully validated `questions`.
Malformed questions and unknown properties are rejected before preparation or paid
work. Identical scopes share local preparation; judgments and cost remain specific
to each question. Progress values increase across the entire call.

Optional top-level `max_input_tokens`, `max_cost_usd`, `max_search_ms` and
`max_context_tokens` apply to the entire call. Spend and input budgets are consumed
in question order; the deadline starts at admission, including queued time.
Remaining response capacity is divided among pending questions. A call response
budget must allow 1024 tokens per question plus 64 per result and 64 for the wrapper.
Each question's limits and operator caps can narrow those allowances further.
Cost budgets need configured pricing; reported usage can still be unknown, so
reservations and estimates do not guarantee a provider billing ceiling.

Response selection keeps its conservative preflight, then makes up to three refill
passes using the actual report size. The complete serialized result is measured
again after selection, including continuation and coverage data.

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
