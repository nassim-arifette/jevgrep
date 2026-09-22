# Grouped score-cache writes — 2026-09-22

`ScoreCache.writeMany()` persists one provider response under one lock, one
directory-size reconciliation and one eviction pass. Per-entry files and their
atomic writes remain unchanged. The engine now passes all valid scores from one
response together. The cache's TTL, identity and model-revision policies are
unchanged.

The comparison uses the same 64-file synthetic Windows workload, Node v24.15.0,
three independent profiled samples and four ordered searches as the
[initial baseline](2026-09-21.md). The [before](local-windows-node24.json),
[first implementation](local-windows-node24-cache-bulk.json) and
[final code](local-windows-node24-cache-bulk-final.json) reports retain raw
samples and fingerprints. The final code adds size-limit enforcement if an entry
write fails midway through a group; the normal write path is unchanged. The
offline provider supplies fixed scores; these runs measure local behavior, not
retrieval quality or real network latency.

| Scenario | Elapsed median before / first / final | Cache-write median before / first / final |
| --- | ---: | ---: |
| First search | 20.97 / 14.06 / 23.77 s | 12.46 / 5.36 / 9.17 s |
| Same question | 2.57 / 4.40 / 6.64 s | 0 / 0 / 0 s |
| New question, unchanged files | 13.15 / 12.99 / 24.20 s | 8.59 / 5.16 / 9.01 s |
| Original question after one-file edit | 2.55 / 3.93 / 7.09 s | 0.15 / 0.24 / 0.42 s |

Each uncached search still persists 64 scores, but `cache_write` now has one
measured call rather than 64. All four scenarios completed and retained the
expected score-cache states. `npm run verify` passed 422 tests, with two
platform-dependent skips, followed by build and eight smoke checks.

The first post-change run showed substantially faster cache writes for uncached
searches. The final-code run was much slower across *all* scenarios, including a
repeated question with no writes. These unpaired runs do not establish a stable
latency gain or regression. They do establish the structural reduction from 64
lock/accounting passes to one for a 64-score response, with unchanged cache
behavior in the four scenarios. The remaining cache-write cost warrants scaling
to more entries and separating lock, inventory and file-write costs. The next
local optimization is repeated batch serialization and token counting.

## Paired cache-write check

To isolate the changed path from the rest of a search, run:

```sh
npm run bench:cache -- --pairs 5
```

This writes the same 64 valid scores to a fresh cache directory by either 64
`write()` calls or one `writeMany()` call. It warms both paths, alternates their
order across five pairs, reads back every score outside the timed region, and
deletes each temporary cache after verification. The [raw paired results](cache-write-paired-2026-09-22.json)
show median write times of **10.57 s individually** and **4.26 s grouped**;
the median within-pair speed ratio was **2.36×**. Grouped writes were faster in
all five pairs (individual/grouped ratios 2.14×–3.55×). This is evidence of a
real cache-write improvement on this Windows host. It does not measure the
whole search, where preparation, batching, selection and provider time still
contribute.
