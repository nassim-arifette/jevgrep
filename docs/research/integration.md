# JevGrep integration and implementation research

Research date: **2026-09-19**. Scope: local MCP/Codex integration, runtime and parser choices, and response accounting. Recommendations below are design proposals, not tested implementation guarantees. No provider calls, package installation, or configuration changes were made.

The project specification is authoritative. Subsequent user decisions confirm TypeScript and leave optional spending and aggregate scan caps **off by default**; timeouts and the configurable response budget remain active. Alternatives and recommendations below document the research rationale, not unresolved implementation requirements.

## Recommendation

Use a TypeScript core, the TypeScript compiler's syntax parser for the JS/TS MVP, a thin CLI, and an official MCP SDK stdio adapter. Keep the engine independent of the SDK and parser. Pin actual dependency versions only after a compatibility spike with the supported Codex version. Expose one bounded search request initially; do not require sampling, elicitation, asynchronous MCP tasks, or client roots.

This recommendation favors a small JS/TS-focused product. A Python core with tree-sitter was considered if verified reuse of Jev's Python tooling saved more work than a single-language implementation; the user has selected TypeScript.

## Local evidence and Codex configuration

The installed CLI package at `C:/nvm4w/nodejs/node_modules/@openai/codex/package.json` reports version `0.153.4`. Its installed README links to official online docs but does not ship the underlying MCP implementation. The read-only command `codex mcp add --help` confirms command-based stdio registration and environment forwarding. This does not establish the desktop application's bundled version or actual negotiated MCP protocol.

Codex supports local stdio servers. Configuration supplies `command`, `args`, optional `cwd`, and environment variables. `env_vars` forwards named existing variables; avoid writing API key values into checked-in examples. Current documented defaults are 10 seconds for server startup and 60 seconds per tool call. Use an explicitly installed executable and absolute application/configuration paths for repeatable startup. The example below is proposed JevGrep syntax, not an implemented command. [Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

```toml
[mcp_servers.jevgrep]
command = "node"
args = ["C:/tools/jevgrep/dist/cli.js", "mcp", "--config", "C:/Users/example/.config/jevgrep/project.json"]
env_vars = ["TYPESAFE_API_KEY"]
startup_timeout_sec = 15
tool_timeout_sec = 75
enabled_tools = ["semantic_search_code"]
```

The sample 75-second host timeout is only suitable if the configured search deadline plus finalization margin is shorter; for example, 60 seconds of work and 10 seconds of cleanup. Do not assume progress notifications extend a Codex timeout. Measure startup with cold caches; initialization must not scan the repository or call Jev.

Project-local Codex configuration is skipped for untrusted projects. Codex also has a per-tool `output_token_limit`, specified before its documented 20% serialization allowance; that host truncation policy is separate from JevGrep's own context budget. Integration tests must detect when the host truncates a response. The following syntax is documented; the numeric value is illustrative and must accommodate the selected maximum response budget. [Official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

```toml
[mcp_servers.jevgrep.tools.semantic_search_code]
output_token_limit = 12000
```

**Proposed trust boundary:** server-owned configuration fixes the repository root, destination provider, secret handling, any explicitly enabled scan/spending limits, and cache location. Request arguments can narrow scope and lower enabled limits, never expand authorization. Repository configuration may add exclusions or lower enabled limits but cannot grant network permission, change endpoints, load executable plugins, or expand roots. A repository's trust in Codex does not replace JevGrep's own policy checks. Do not parse arbitrary repository configuration as JavaScript. Do not inherit the repository's `.env` automatically. A host `cwd` is a process launch setting, not an authorization boundary.

## MCP contract and compatibility

Both TypeScript and Python are official Tier 1 MCP SDK languages. This alone does not select package versions or prove compatibility with a particular host. [MCP SDK directory](https://modelcontextprotocol.io/docs/2026-07-28/sdk).

Current documentation includes both 2025 and 2026 protocol eras. The TypeScript migration guide distinguishes a directly connected legacy stdio transport from its newer dual-era `serveStdio` entry point; merely upgrading a dependency does not switch the protocol. The chosen adapter must use APIs documented for its pinned SDK and demonstrate real child-process interoperability. Do not mix snippets from SDK generations. [Official TypeScript migration guidance](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

Use SDK-managed framing. Stdio carries newline-delimited JSON-RPC; stdout is reserved for protocol messages, and diagnostic logging goes to stderr. Closing stdin is a portable server shutdown signal. The 2026 stdio contract forbids further messages for a cancelled request. [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).

Proposed tool arguments are a bounded question, relative scope paths, and a response-token budget. The tool description must say that authorized excerpts are transmitted to the configured Jev service and that results contain selected source evidence. Do not claim the operation is local-only or that returned matches prove a bug's cause. Keep the tool list deterministic and the schema small.

### Results and errors

MCP permits ordinary text content and optional structured content. If a tool declares an `outputSchema`, its structured result must match that schema. The 2025 format requires an object; the 2026 format permits any JSON value. Both recommend a serialized text copy for compatibility. An object envelope works across both. Protocol errors cover malformed protocol requests and unknown tools; a valid call that cannot execute uses `isError: true`. [2025 tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [2026 tool contract](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Two viable result formats:

| Format | Benefit | Cost |
| --- | --- | --- |
| One `TextContent` containing canonical JSON; validate internally and omit MCP `outputSchema` | Simple, one copy of every excerpt, works with text consumers | No MCP structured-output declaration |
| `structuredContent` plus compatible serialized text | Machine-readable MCP schema and broad compatibility | The host may expose both copies; budget and rendering require verification |

**Recommendation:** use one canonical JSON text block for the initial Codex integration, with the same internally validated object available through CLI JSON. Add structured output after verifying how the supported Codex version exposes and counts it. If structured output is a firm requirement immediately, budget both representations conservatively and test the host. Never assume `structuredContent` is invisible to the model.

Proposed status mapping:

| Situation | Behavior |
| --- | --- |
| Complete eligible scan, including no selected matches | Successful result with explicit coverage and selection counts |
| Internal deadline, scan cap, or some provider failures after useful evaluation | Successful `partial` result with machine-readable stop reason and unevaluated counts |
| Invalid application arguments, denied path, missing credentials, incompatible provider configuration | Tool execution error with stable code and a concise recovery hint |
| No usable evaluation due to provider failure | Tool execution error; no fabricated score or empty-success inference |
| Malformed JSON-RPC or unknown tool | SDK protocol error |
| Client cancels | Stop work and emit no new result; client cancellation is not an internal deadline |

These mappings are application decisions. In particular, define `partial` separately from `isError`; Codex must see why a search is incomplete. A valid score from cache can count as evaluated, but coverage must identify the cache provenance.

### Progress, cancellation, and limits

For the legacy progress contract, emit updates only for a request that supplied an active progress token. Values must increase, totals may be omitted, and updates stop after completion. Use the selected SDK's protocol-aware progress API; do not build a protocol-era assumption into the search engine. [MCP progress contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress).

The legacy cancellation contract advises stopping processing, releasing resources, and not sending a response; late or unknown cancellations are race conditions to handle safely. [MCP cancellation contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

Proposed implementation: one cancellation/deadline signal reaches inventory, chunking, queue dispatch, retries, provider requests, and response assembly. Stop new work immediately, abort cancellable requests, and release permits in `finally` paths. Aborting an HTTP request cannot guarantee that remote computation or billing stopped. Keep completed score-cache writes atomic; never cache interrupted work as a negative judgment. For internal deadline expiry, reserve enough time to assemble and return partial evidence before the host timeout. Apply concurrency limits across all simultaneous requests in a server process. When spending or aggregate scan caps are explicitly enabled, enforce their documented scope across concurrent work; these optional caps are off by default.

Progress should report counts and phases without code, query text, credentials, or path lists. A monotonic fraction across predetermined phases is simpler than resetting a counter for each phase. Throttle notifications and never depend on them for correctness.

## Runtime and parser alternatives

The TypeScript compiler API supports parsing source text, traversing syntax nodes, and converting source offsets to line/character positions without creating a type checker. Its printer creates output from syntax trees, which is a different operation from preserving original source. [Microsoft compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

Tree-sitter offers official Node.js, WebAssembly, and Python bindings. Its design supports incremental syntax parsing and robust handling of imperfect source. [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/). Tree-sitter nodes carry byte offsets and zero-based row/column coordinates; columns count bytes, and line feeds determine rows. [Tree-sitter parsing documentation](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html).

| Choice | Fit for this project | Tradeoff |
| --- | --- | --- |
| TypeScript + TypeScript compiler parser | Recommended for JS/TS-first CLI and MCP engine; direct access to language syntax kinds | Parser API changes need pinned dependencies; non-JS languages require another adapter |
| TypeScript + tree-sitter | Useful if multiple languages become an immediate requirement | Grammar/runtime packaging, ABI or WASM assets, and language-specific chunk rules add work |
| Python + tree-sitter | Good when Python Jev reuse and experiment tooling dominate | Parser packages still need verification on Windows; calling the TS compiler would add a second runtime |

These are engineering judgments, not measured speed comparisons. There is no reason to claim either language is faster for end-to-end search before measuring provider latency and local workload.

Proposed chunker invariants:

- Parse strings only; never execute source, load repository plugins, run build scripts, or follow type-checking imports outside the inventory.
- Retain original file bytes and decoded text with a declared encoding policy. Slice originals using mapped offsets; never reprint ASTs.
- Preserve top-level expressions, registrations, imports, exports, comments attached to declarations, and configuration-like code. Functions alone are insufficient.
- Partition or account for all eligible source spans. Oversized units split deterministically with boundaries/overlap documented; overlaps cannot multiply coverage counts.
- Parser errors use an explicit bounded line-window fallback or documented exclusion. They must not silently erase candidates.
- Tests cover CRLF, Unicode/astral characters, BOMs, final lines without newlines, JSX/TSX, decorators, nested functions, large class bodies, and malformed input.

## Token accounting

Local tokenizers count plain text, while complete model requests also contain role/formatting boundaries, tool schemas, and model-dependent representation. OpenAI's request-count endpoint counts a complete supplied request; an MCP server does not possess Codex's complete request merely by returning a tool result. [Official OpenAI token-counting guidance](https://developers.openai.com/api/docs/guides/token-counting).

**Proposed guarantee:** `max_context_tokens` constrains the final JevGrep payload according to a declared tokenizer identifier/version, or a clearly labeled estimator when exact local tokenization is unavailable. It does not guarantee exact Codex billing, remaining model context, or provider scan cost. Do not send code to another service merely to count tokens.

Count the final rendered representation, including JSON escapes, source text, paths, line ranges, hashes, coverage, warnings, and token-accounting fields. Fit results only after merging ranges and rendering; remeasure after every removal. Reserve a minimal error/coverage envelope, reject a budget too small to represent it, and bound lists so metadata cannot consume an unbounded budget. In the finalized payload, identify the counter and applied budget; keep the actual rendered count in local diagnostics to avoid making the count part of the text it measures. Coverage can separately report omitted matches. If dual structured/text output is used, the accounting contract must specify both copies.

Track scan tokens separately using Jev's provider accounting where available; unknown billing remains unknown. Cached results can reduce new external work without implying that all source was reread or all billing units are measurable.

## Required compatibility spike

Before locking the implementation, verify: subprocess startup and clean stdout; tool discovery and schema validation; a full result and a no-match result; malformed input and provider failures; multiple concurrent calls; progress both with and without host support; cancellation with no post-cancel messages; EOF shutdown; an internal deadline returning partial data; the largest supported payload without Codex truncation; Unicode/line-range fidelity; and Windows plus at least one POSIX platform. Use a fake provider for these checks. Record the tested Codex, runtime, SDK, parser, protocol, and tokenizer versions rather than inferring them from online documentation.
