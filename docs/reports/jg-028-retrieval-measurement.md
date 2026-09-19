# JG-028 — Retrieval measurement: instrument, protocol, and current status

Prepared 2026-09-19. **A development instrument is tested offline; no retrieval quality
has been measured. Live execution and held-out data are blocked in this runner.** This document says what
exists, what it would produce, and what may not be claimed until a real run happens.

## 1. The instrument

[`benchmarks/tools/run-retrieval.ts`](../../benchmarks/tools/run-retrieval.ts) replays a
JG-027 corpus manifest through the shared engine and writes one run record.

```bash
# offline plumbing check (no provider, no credential)
node benchmarks/tools/run-retrieval.ts \
  --manifest benchmarks/manifests/development/subscription-cache.development.json \
  --provider offline --cache cold --out benchmarks/results/subscription-cache-cold

# --provider live is refused until provider, source and scheduler qualification.
# Held-out manifests are refused until a separate isolated executor is implemented.
```

Each run emits a JSON record and a Markdown summary. The JSON record is the evidence; the
Markdown is for reading.

### What every run records

- **Reproduction context**: timestamp, Node version, provider mode, cache state, response
  counter id, criterion version, request-layout version, chunker versions, the settings in
  force (threshold, budget, concurrency, deadline, file limit) and the configuration
  fingerprint.
- **Corpus identity**: manifest file, split, fixture id and the fixture's recorded revision.
- **Per question**: status, selection outcome, stop reasons, excerpt count, measured
  response tokens, latency, annotated evidence found (total and direct-only), how many
  returned excerpts overlap an annotation, provider attempts, known input tokens, attempts
  with unknown usage, estimated cost, cache reuse and whether the scope was fully scanned.
- **Summary**: counts of complete / partial / rejected / failed / empty searches, evidence
  recall, direct-evidence recall, annotated precision, median and p90 latency, median and
  maximum response tokens, total attempts, attempts with unknown usage, known input tokens,
  reused fragments.

### Rules the instrument enforces

- **Failures are results.** Partial, empty, rejected and failed searches appear in the
  report; nothing is filtered out to make a number look better
  (`tests/retrieval-benchmark.test.ts`).
- **Unknown usage is unknown.** An attempt whose usage the provider did not report is
  counted in `attempts_with_unknown_usage`; it never contributes zero to a cost. Without a
  dated pricing record, `estimated_cost_usd` stays `null`.
- **Cold and warm runs are separate.** `--cache cold` clears the configured cache first.
  Reuse changes the accounting, never the selected evidence — asserted by a test.
- **Annotations are a revisable reference.** Recall is measured against annotated ranges;
  precision is labelled *annotated* precision, because an unannotated excerpt is not
  proven useless. Every report prints that caveat.
- **Offline mode is labelled.** The offline scorer is a lexical overlap function used to
  exercise the runner. Its first caveat line says, in every report it produces, that the
  numbers do not measure Jev retrieval quality.

## 2. Protocol for a real measurement

1. Close JG-004 (provider contract), JG-005 (request layout), JG-008 and JG-016/JG-017.
   Qualify the instrument's manifest validation and scoring against JG-027: current
   overlap counts do not implement complete evidence sets, alternatives or ambiguity.
   A retrieval number
   measured with an unsettled layout measures the layout, not the engine.
2. Configure an explicit experimental budget: enable the `benchmark` profile caps of
   specification §7.3 and record them beside the results.
3. Run the **development** split, cold then warm. Keep both.
4. Tune only on development: threshold, fragment size, batch width. Record every variant
   as its own run record.
5. Freeze the settings: write `benchmarks/settings/proposed-settings.json` with
   `"frozen": true`, a UTC timestamp and the run ids that justify the values.
6. Verify a separate executor cannot read annotations or reserved questions; merely
   placing answers in a sibling directory is insufficient. Only then run the **held-out**
   split with that executor, once, and report it separately, with failures
   broken down by question category (behaviour, exact-symbol control, no-evidence).

## 3. Current status

| Item | State |
| --- | --- |
| Runner | provisional development instrument, tested offline; live/holdout gated |
| Corpus | JG-027: six fixtures, 42 development questions and 12 held-out questions on three separate fixtures |
| Settings | [proposed, **not frozen**](../../benchmarks/settings/proposed-settings.json) |
| Development run (live) | **not executed** — no provider access |
| Held-out run | **not executed**, and must stay unexecuted until the settings are frozen |
| Quality claim | **none**. The offline run exercises the plumbing only |

Tests exercise all development questions, retain partial/empty/failed outcomes and
check output budgets. Counts from the lexical scorer describe the test harness only;
they do not qualify the measurement method or Jev retrieval quality.

## 4. What may not be said yet

- No precision, recall or coverage figure may be attributed to Jev.
- No latency figure may be presented as production latency: the offline scorer has no
  network cost.
- No cost figure exists at all, since no dated pricing record is configured and no call
  was made.
- The threshold of 0.5 remains an unvalidated baseline. A Noul score is an uncalibrated
  retrieval signal until this benchmark says otherwise.
