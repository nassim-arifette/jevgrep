# Public contracts — JG-002

[`src/contracts.ts`](../src/contracts.ts) is the executable source of truth. Its public types are inferred from the runtime schemas: `SearchRequest`, `ResolvedSearchRequest`, `SearchResult`, `SearchError`, `SearchOutcome`, `Configuration` and `Diagnostics`. No separate CLI or MCP output schema is maintained. This reference fixes the v1 names described in specification §4, §7.4 and §10.

Each schema exposes `parse(unknown)` and `safeParse(unknown)`. Parsing returns a new validated object without mutating input, coercing types, executing configuration, reading files, inspecting environment variables or contacting a provider. Unknown keys are rejected at every object level, including reason/cap maps. Validation errors identify the field and rule without including rejected keys or values. Plain JSON data is required; accessors, custom object prototypes, symbols and malformed Unicode are rejected.

`schema_version` is the string `"1"` for results, errors and diagnostics, and the number `1` for configuration, as specified. Tool arguments intentionally have no version field: adding one is an unknown-key error. Their version is defined by the v1 tool contract.

## Requests and scope

Use `parseSearchRequest(input, configuration.search)` at the engine boundary. It preserves the **exact original query**, normalizes/collapses scope entries and supplies missing defaults. `searchRequestSchema` validates the optional input shape with the initial limits; `createSearchRequestSchema(limits)` uses the operator's response limits.

| Field | Contract |
| --- | --- |
| `query` | Nonblank after a whitespace check; at most 8,192 UTF-8 bytes; no trimming, Unicode normalization or newline rewriting |
| `scope` | Default `["."]`; 1–32 paths; at most 4,096 combined UTF-8 bytes before normalization or deduplication |
| `max_context_tokens` | Safe integer; minimum 1,024, default 4,000, initial configured maximum 16,000 |
| `allow_partial_scan` | Boolean, default `false`; cannot raise an operator cap |

Scope accepts `/` or `\` separators, removes `.` and repeated separators, then removes duplicate/covered paths and sorts by ordinal string order. Paths are case-preserving; filesystem case/identity checks belong to JG-008. Parent traversal, absolute/drive-relative/UNC/device paths, NUL/control characters, alternate data streams, glob syntax, reserved Windows device names and ambiguous trailing dots/spaces are rejected on both platforms. Coverage compares segments: `src` covers `src/cache.ts`, never `src2/cache.ts`.

Result scopes must already be canonical. Excerpt and optional diagnostic file paths use canonical repository-relative `/` paths and cannot be `.`. These checks are lexical only. Root canonicalization, symlink/junction exclusion, containment and revalidation when opening/sending files remain JG-008 responsibilities.

## Configuration and units

`configurationSchema` validates the complete configuration in specification §7.4. `createDefaultConfiguration(absoluteRoot, model)` creates those defaults with remote disclosure disabled, all seven optional caps set to `null`, and no assumed pricing. The model must be supplied explicitly; this helper makes no claim about provider availability.

| Quantity | Unit / bound |
| --- | --- |
| Counters, lines, bytes and token counts | Nonnegative safe integers, at most `Number.MAX_SAFE_INTEGER`; line numbers start at 1 and are inclusive |
| Counter sums | Must remain safe integers; checked without floating-point addition loss |
| Text size limits | UTF-8 bytes, not UTF-16 code units |
| `elapsed_ms`, `deadline_ms` | Integer milliseconds; deadline must be positive |
| Cache `ttl_seconds` | Positive integer seconds; initially 604,800 |
| Cache `max_bytes` / source `max_file_bytes` | Positive integer bytes; initially 104,857,600 / 1,048,576 |
| Concurrency | Positive safe integer; initially 4 |
| Scores and threshold | Finite numbers in `[0,1]`; initial threshold 0.5 |
| USD amounts | Nonnegative USD, representable in integer nanodollars (1e-9 USD), at most `Number.MAX_SAFE_INTEGER / 1e9` USD |
| Response accounting | Reference tokens under the named counter, including the entire serialization |
| IDs | At most 128 UTF-8 bytes; ASCII letter/digit followed by letters/digits or `._:@/+-` |
| File hashes | 64 lowercase hex characters: SHA-256 of the original file bytes |

The USD bound is an arithmetic bound, not an enabled spending limit. Ordinary decimal floating-point representation noise is tolerated. Accounting implementations must use integer monetary units internally.

Every optional cap is explicitly present in configuration. `null` disables it; **zero permits zero work in that dimension**. Negative values, fractional count caps and strings are invalid.

| Cap key | Unit |
| --- | --- |
| `estimated_cost_usd` | Estimated USD |
| `estimated_input_tokens` | Estimated provider input tokens |
| `transmitted_bytes` | Serialized outbound bytes, including retries |
| `request_attempts` | Aggregate dispatched attempts, including retries |
| `prepared_source_bytes` | Accepted source bytes prepared locally |
| `candidate_files` | Candidate files |
| `fragments` | Unique prepared fragments, independent of retries |

`provider.pricing` is an optional nullable v1 extension to the configuration example. Fields: `model`, `verified_at` (valid `YYYY-MM-DD` date), `input_usd_per_million_tokens` and `output_usd_per_million_tokens`. Prices are explicitly supplied, including any zero output price. The model must match `provider.model`. Enabling any USD cap, including zero, requires this dated matching record. Checking applicable real prices/model access belongs to JG-004/007. Missing pricing means estimated USD is unknown, not free.

Only `https://api.typesafe.ai` (optionally followed by `/`) is accepted as the endpoint. Credentials, query parameters, alternate ports and custom hosts are unsupported. Secrets belong in the environment variable named by `api_key_env`. `follow_links=true`, `include_source=true` and `require_fit=false` are rejected; explicit partial scanning uses `allow_partial_scan`. Unsupported advanced settings are rejected rather than accepted without an implementation. Logging levels: `silent`, `error`, `warn`, `info`, `debug`.

## Outcomes, coverage and counters

| Status | Meaning | CLI exit | MCP `isError` |
| --- | --- | --- | --- |
| `complete` | Inventory/preparation and every eligible evaluation completed; selected sources remain fresh; an empty selection is valid | 0 | false |
| `partial` | Incomplete work or stale selected sources; preserve successful evidence, including an empty selection | 3 | false |
| `rejected` | Invalid request/configuration or zero-call preflight rejection | 2 | true |
| `error` | Fatal failure with no successful evaluation, or an early failure without a trustworthy report | 4 | true |

Interruption maps to CLI exit 130. The MCP lifecycle must suppress new responses after client cancellation; a serializer is not a cancellation handler.

`SearchOutcome` is either the full `SearchResult` or compact `SearchError`. Compact errors have fixed code-specific recovery guidance, status and retry advice from `ERROR_DEFINITIONS`; raw provider messages cannot enter the payload. A fatal failure after any successful remote/cache evaluation must preserve it as `partial`. A deadline with no successful evaluation is `partial / no_successful_evaluation`; fatal authentication/quota/resource failures with no successful evaluation are `error`.

The schema checks these identities for known terminal counts:

```text
remote_evaluated + cache_reused = below_threshold + above_threshold
above_threshold = represented_in_response + omitted_by_response_budget + omitted_stale
total = remote_evaluated + cache_reused + not_evaluated  (when total is known)
ranges_returned = excerpts.length
```

Counts describe unique fragments, not attempts or merged ranges. Returned ranges cannot exceed represented fragments. Scores must be finite and at least the threshold; zero is valid when the threshold allows it, but a missing/invalid score is never zero. Excerpts cannot escape the reported scope, repeat an identical range or mix hashes for the same path. Verifying code against actual snapshots remains JG-011/021 work.

`inventory_complete=false` or unreadable source requires `total=null`; known counters are lower bounds. Incomplete preparation requires `planned_remote_fragments=null`. `scope_fully_scanned` can be true only for `complete`, with known preparation, zero unavailable evaluations and zero unreadable/changed files. Response omissions alone do not make coverage partial. Changed files require `SOURCE_CHANGED`; stale qualifying fragments require a changed-file count.

File counts are not an additive partition: `eligible` counts files known to pass eligibility; unreadability can occur before or after classification. `eligible + sum(excluded_by_reason) <= discovered`, `unreadable <= discovered`, and `changed_before_return <= eligible`. Directory exclusions are separate diagnostics; unvisited descendants do not fabricate file counts.

Empty-selection precedence is enforced: preflight rejection; no eligible content only with finished inventory/preparation and zero fragments; no successful evaluation; no score above threshold; all qualifying fragments stale; otherwise no excerpt fits. Any returned range implies `selected`.

For a reported preflight rejection, remote/cache evaluation and actual usage remain zero, even when `planned_cache_hits > 0`. Every prepared fragment remains `not_evaluated`. The report identifies an exceeded enabled cap, or unknown requirements after preparation stopped at a cap. With known preparation, planned remote fragments plus potential cache hits equal the total. `estimated_required_caps` has exactly the enabled keys and units, agrees with corresponding first-attempt estimates, and uses `null` only for incomplete preparation. Disabled-cap reports have two empty maps.

`provider_input_tokens_reported` equals the known subtotal only when every dispatched attempt has known usage; otherwise it is `null`. Zero attempts give reported/subtotal/estimated tokens and transmitted bytes equal to zero. With all usage unknown, the known subtotal is zero but the total remains unknown. `USAGE_UNKNOWN` records that condition. Fully known usage replaces estimates; otherwise the estimate retains known usage plus conservative reservations. Monetary totals remain nullable: computed price is an estimate, not provider-reported cost. Preflight estimates never become incurred usage on a zero-call rejection.

## Codes and diagnostics

`STOP_REASONS`, `ERROR_CODES`, `EXCLUSION_REASONS` and `DIAGNOSTIC_CODES` are finite public vocabularies. Unknown keys/codes and duplicate stop reasons are rejected. Stop lists contain at most one of each known code.

| Codes | Compact error behavior / use |
| --- | --- |
| `INVALID_REQUEST`, `INVALID_CONFIG`, `UNAUTHORIZED_SCOPE`, `REMOTE_DISABLED`, `CREDENTIAL_MISSING`, `SCOPE_EXCEEDS_SCAN_BUDGET`, `RESPONSE_BUDGET_TOO_SMALL` | Rejected, not automatically retryable; correct input/configuration or scope |
| `BUSY` | Rejected, retryable after waiting |
| `PROVIDER_AUTH`, `PROVIDER_QUOTA`, `INVALID_PROVIDER_RESPONSE`, `RESOURCE_EXHAUSTED`, `CANCELLED` | Fatal compact error, not automatically retryable |
| `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE` | Fatal compact error, retryable; advice does not authorize paid ambiguous retries |
| `INVENTORY_INCOMPLETE`, `PREPARATION_LIMIT`, `SCAN_CAP_REACHED`, `DEADLINE`, `SOURCE_CHANGED` | Report stop reasons; retain the report and completed evaluations |
| `USAGE_UNKNOWN`, `ESTIMATE_OVERRUN` | Accounting reasons; can coexist with complete coverage if all scores were obtained |
| `PARSE_FALLBACK`, `CACHE_MISS`, `CACHE_UNAVAILABLE`, `EXCLUDED_DIRECTORY` | Additional local diagnostic events |

Exclusion keys: `administrative`, `credential_file`, `operator_denied`, `gitignored`, `jevgrepignored`, `dependency`, `build_output`, `generated`, `minified`, `unsupported_encoding`, `binary`, `file_too_large`, `credential_pattern`, `empty`, `whitespace_only`, `unsupported_format`, `unsupported_long_line`, `link`, `outside_root`, `not_regular_file`. Apply the first applicable exclusion from specification §5.2; empty/whitespace-only content contributes zero fragments.

`Diagnostics` contains version, search ID, at most 64 events (`code`, `elapsed_ms`, optional `count` and relative `path`), `excluded_directories_by_reason`, `observed_cap_lower_bounds`, nullable `response_tokens_measured`, and `truncated`. Paths must be emitted only under opt-in local path diagnostics. No source/query/message/body field is accepted. Lower bounds do not substitute for terminal counters. The engine must reflect local truncation in the matching public `diagnostics_truncated` flag.

## Shared presentation and verification

[`src/search-response.ts`](../src/search-response.ts) provides `toCliSearchResponse` and `toMcpSearchResponse`. Both validate `SearchOutcome`, compactly serialize the same object and count the entire escaped payload. MCP returns one JSON text block without duplicate structured content. The CLI JSON string contains no appended newline; a future writer must account for any added framing separately.

Both require a `ResponseTokenCounter` (`id`, `count(serialized)`). Its ID must match the result's declared counter. Results must fit requested tokens; compact errors must fit both 4,096 UTF-8 bytes and 1,024 reference tokens, regardless of an invalid smaller requested budget. Measured counts stay in local diagnostics, outside the counted payload. Invalid contracts, mismatched counters and oversized serialization throw `ContractValidationError`; response selection/envelope fitting belongs to JG-020 and happens before this final boundary.

No production tokenizer, provider or MCP SDK is selected here. Fixtures use a synthetic byte counter; JG-006 validates the real tokenizer. CLI/MCP engine integration remains JG-014/024. The CLI scaffold imports the shared exit mapping and continues to report unfinished commands as unavailable.

Valid and invalid examples for every public contract are in [`tests/fixtures/contracts.ts`](../tests/fixtures/contracts.ts). They cover complete/partial/rejected/fatal outcomes, every empty-selection reason, unknown totals/usage, cache-aware zero-call rejection and cache-only reuse. Tests in [`tests/contract`](../tests/contract) exercise malformed inputs, UTF-8/path boundaries, cap semantics, counter identities, bounded diagnostics and identical CLI/MCP serialization. Run `npm run verify` for the offline project gate.
