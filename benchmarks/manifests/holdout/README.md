# Held-out questions

The held-out split is versioned here as **questions and provenance only**. Reference
evidence, alternative evidence and review notes live outside the working tree an evaluated
agent can read: each manifest points to them through `answers_ref` (JG-027 acceptance
criterion 5, specification §11.2).

`benchmarks/tools/check-corpus.ts` enforces this. A manifest under this directory is a
defect if it contains `expected_evidence`, `alternative_evidence_sets` or `review_notes`.
It must instead declare `answers_ref`, and that file is validated when it is readable.

## Answer-file convention

One operator-side JSON file holds every fixture section. The default location on this
workstation is `C:/Users/<user>/Desktop/jevgrep-holdout-answers/holdout.answers.json`,
outside the checkout:

```json
{
  "schema_version": 1,
  "kind": "holdout-answers",
  "fixtures": {
    "orders-api": {
      "revision": { "kind": "tree-sha256", "value": "<fixture fingerprint>" },
      "answers": [
        { "id": "orders-api.holdout.001", "expected_evidence": [ { "path": "src/app.ts", "start_line": 1, "end_line": 9, "role": "direct" } ], "ambiguous": false, "review_notes": "..." }
      ]
    }
  }
}
```

Validation rules for an available answer file:

- `revision.value` must equal the fixture's current fingerprint, so any fixture edit makes
  the answers stale until they are re-reviewed.
- every question of the held-out manifest must have exactly one answer, and no answer may
  refer to a question outside that manifest;
- every reference range must exist inside the fixture, with `1 <= start_line <= end_line`.

A missing answer file is a **note**, never a defect: CI does not hold the answers, a release
or tuning run does. The report says which files were unavailable, so the difference between
"validated" and "not checked here" stays visible.

The split is frozen before any threshold, fragment size or batching tuning (JG-028).
