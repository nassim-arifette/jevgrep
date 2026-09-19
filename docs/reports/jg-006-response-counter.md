# JG-006 — pinned local response tokenizer

Selected on 2026-09-19: **tiktoken 1.0.22**, encoding **cl100k_base**,
counter identity `tiktoken@1.0.22/cl100k_base`. The package and archive integrity are
pinned in package.json/package-lock.json. This is dqbd's WASM binding to tiktoken;
its vocabulary and WASM binary are installed locally, with no network at runtime.
[Package source](https://github.com/dqbd/tiktoken),
[version metadata](https://registry.npmjs.org/tiktoken/1.0.22).

This replaces the unvalidated `jevgrep-reference-1` heuristic, which did not meet
specification 8.2's requirement to record a tokenizer package and encoding.
The selected encoding is a reproducible local measure of the complete serialized
JevGrep payload. It is not a claim about the billing or hidden framing of Jev/Codex.

One encoder is initialized lazily and reused. `encode(text, [], [])` treats special
token markers as ordinary source text. No Unicode normalization is performed.
Ten fixed vectors cover Unicode, combining marks, emoji, CRLF, JSON escapes and
literal markers. The tests run with network entry points disabled and exercise both
CLI/MCP payload serializers. These are adapter tests, not a live Codex compatibility run.

The pure-JS alternative `js-tiktoken@1.0.21` was also tried. On this Windows/Node24.15
host, the original 20,000-character repeated-word rejection test spent about 104 seconds
tokenizing bytes that were already too large. The chunker now rejects by byte count
first and records an unmeasured token count as null. The source-shape sweep took about
16 seconds with pure JS versus 2.3 seconds with WASM in separate local runs; these are
diagnostic observations, not a portable benchmark. The final line-window suite passed
15 cases with WASM, and the byte-first regression prevents this unnecessary work.

Neither line concatenation nor substring deletion preserves BPE counts additively or
monotonically: `establish` counts as 1, `stablish` as 2. Selection must reserialize and
recount after each range removal, with termination based on the shrinking range list.
Counters/fragment identities must retain the tokenizer version; old measured values
cannot be reused as if they came from this encoding.

JG-006 remains open for the real Codex/MCP discovery, large-response, cancellation and
stdin-close compatibility matrix. No successful desktop integration is inferred from
the local tokenizer or adapter tests.
