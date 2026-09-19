# JG-006 — MCP transport and interoperability

Prepared 2026-09-19 on Windows 11 (26200), Node.js 24.15.0, npm 11.12.1.
This is the **transport half** of JG-006. The response counter half — the pinned
`tiktoken@1.0.22/cl100k_base` reference tokenizer, its encoding and its guarantee — is
recorded in [jg-006-response-counter.md](jg-006-response-counter.md).

**Status: the draft transport is exercised locally; real Codex interoperability is
untested.** The executable is not wired to this module. See the qualification gates
in [the handoff](../handoff.md).

## 1. Transport decision

The draft does not use the MCP TypeScript SDK. It implements stdio framing in
[`src/mcp.ts`](../../src/mcp.ts): one JSON-RPC 2.0 message per line, protocol on stdout,
diagnostics on stderr. This is a provisional implementation, not the SDK-based
transport requested by specification §4.4. Offline testing does not prevent pinning
an SDK. The SDK decision, bounded stream handling and client compatibility remain open.

This keeps two of the specification's requirements true by construction rather than by
configuration: there is no hidden retry, and there is no debug logger that could write a
request body containing source. Replacing this file with the SDK later changes the
adapter only — the engine has no MCP knowledge at all.

## 2. Versions actually exercised

| Component | Version | How it was exercised |
| --- | --- | --- |
| Node.js | 24.15.0, Windows 11 | in-process streams and a real child process |
| MCP protocol | `2025-06-18` tested at `initialize`; the draft also advertises `2025-03-26` and `2024-11-05` | local tests do not qualify every advertised version |
| JevGrep server | [`src/mcp.ts`](../../src/mcp.ts), tool `semantic_search_code` | discovery, call, error mapping, cancellation, EOF |
| Provider | scripted client, no network | every case |
| **Codex** | **not tested** | no real-client interoperability run performed |

## 3. Behaviours verified

- **Offline start.** Startup scans no repository and contacts no provider; `tools/list`
  answers before any search is run.
- **One tool, strict schema.** `query`, `scope`, `max_context_tokens`,
  `allow_partial_scan`, `additionalProperties: false`. Root, credential, provider
  endpoint, model and operator caps are absent from the schema, so no client can widen
  authorization through a tool call; a client root hint remains a hint.
- **One copy of the payload.** A single `TextContent` block with the validated JSON
  outcome. No `outputSchema` and no `structuredContent`, so a client never receives the
  excerpts twice and never sees a declared schema without matching structured output.
- **Error mapping.** `complete` and `partial` → `isError: false`; `rejected` and `error`
  → `isError: true`; unknown method and unknown tool remain JSON-RPC errors; a malformed
  line is a parse error, not a silent drop.
- **Cancellation.** After `notifications/cancelled`, the in-flight search is aborted and
  **no result is emitted** for that request id.
- **Backpressure.** One active search plus one queued search; beyond that the contract's
  `BUSY` rejection is returned rather than queueing without bound (specification §6.3).
  Waiting consumes the same deadline; an expired queued search dispatches nothing.
  This bounds search admission, not all input/output stream buffers.
- **stdout purity and EOF.** In a child process, every stdout line parses as a JSON-RPC
  message, and closing stdin ends the process with exit code 0 once in-flight calls settle.
- **Parity with the CLI.** The same request through the engine directly and through the
  MCP tool produces the same payload after removing the generated search id and the
  elapsed time (requirement R10).

## 4. Client settings to confirm, and why they are not measured here

| Setting | Proposed value | Why it is not verified |
| --- | --- | --- |
| Client tool timeout | ≥ 75 s with the default 60 s internal deadline | needs a real client; the margin covers finalisation after the internal deadline |
| Client output limit | above the configured `max_response_tokens` | the truncation behaviour is the client's, not ours |
| Largest response accepted whole | to be measured at `max_context_tokens = 16 000` | requires Codex |

The real-client check still to run: issue a search whose response uses the
full configured budget, confirm the client displays or forwards it without truncation,
and record the client version in the matrix above. Until then, JG-026's criterion about
the largest response remains open, and this report says so rather than assuming it.

## 5. Consequences

- JG-024 inherits this transport; its tests are the ones listed above.
- JG-026 must record the Codex version, timeout and output limit in its matrix once they
  can be measured.
- If the MCP SDK is pinned later, re-run `tests/mcp-server.test.ts` against it before
  claiming SDK compatibility anywhere.
