# Batch measurement and payload reuse — 2026-09-22

The engine now measures each model-visible singleton once for cache identity and
batch admission. Candidate batch checks reuse exact token counts for identical
serialized state and question JSON, within an 8 MiB retained-string budget.
Final batch token/byte measurements are reused for planning and dispatch. Up to
16 MiB of final serialized bodies are retained for provider dispatch and retries;
larger workloads fall back to adapter serialization while keeping the exact
measurements. Direct TypeSafe and OpenRouter send the retained body unchanged.
Vercel Gateway reads its state and questions from that same body before passing
them to the SDK.

The [before](local-windows-node24-cache-bulk-final.json) and
[after](local-windows-node24-batching-reuse.json) reports use the same 64-file
synthetic offline workload with three samples each. Every scenario completed,
with the same provider-attempt counts, score-cache reuse and modeled transmitted
bytes. These are unpaired runs on a variable Windows host.

| Cold/new-question measurement | Before | After |
| --- | ---: | ---: |
| Engine-requested serializations | 198 | 127 |
| Question entries across serializations | 2,655 | 2,143 |
| Reference-tokenizer calls | 7,428 | 5,219 |
| Batch-packing median, cold | 7.42 s | 3.72 s |
| Batch-packing median, new question | 7.80 s | 3.57 s |
| Full search median, cold | 23.77 s | 20.48 s |
| Full search median, new question | 24.20 s | 19.25 s |

Batch-packing time is inclusive. Some work moved into `cache_lookup`, where
singleton inputs are measured once; `planning` fell from roughly 0.26 s to below
0.01 s. The exact count reductions and unchanged modeled transmission are
repeatable properties of this workload. The elapsed medians are directional
only: host variation affected even scenarios with no batching. The cached
repeat-question case remains at 64 serializations and 5,026 tokenizer calls,
because preparation still runs on every search.
