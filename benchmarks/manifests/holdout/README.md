# Held-out questions

Protocol v1 uses fixtures disjoint from development. Public manifests contain
question wording, kind, scope, provenance and an opaque `answers_ref` identifier.
The active identifier is `jevgrep-heldout-v2`; it conveys no storage location.

An operator supplies the private file explicitly:

```bash
node benchmarks/tools/check-corpus.ts --answers <absolute-operator-file> --require-answers
```

No answers are read by default. Missing answers are a note in CI and an error with
`--require-answers`. Available answers are validated even without that flag.
The private file must be outside the checkout/corpus, including after resolving aliases.

The operator file schema is:

```json
{
  "schema_version": 1,
  "kind": "holdout-answers",
  "answer_set_id": "jevgrep-heldout-v2",
  "fixtures": {
    "<fixture-id>": {
      "revision": { "kind": "tree-sha256", "value": "<fixture fingerprint>" },
      "answers": [
        {
          "id": "<fixture-id>.holdout.001",
          "expected_evidence": [],
          "alternative_evidence_sets": [],
          "ambiguous": false,
          "review_notes": "<curator rationale>"
        }
      ]
    }
  }
}
```

Empty expected evidence is valid only for a no-evidence question. Other questions
require `path`, inclusive `start_line`/`end_line`, and `role` on every reference range.
Every manifest question must have exactly one answer; unknown IDs, stale revisions,
invalid scopes/ranges, missing roles and invalid alternative sets are defects.
Private symbol controls and ambiguity notes are checked with the development rules.

Do not put real private examples or storage paths in documentation, manifests,
evaluation prompts or test fixtures. Tests generate synthetic answer sets in temporary
operator directories. The real curated answer file is a separate operator artifact,
so a fresh checkout validates public structure but requires operator provisioning to
score holdout.

Outside the checkout is a storage convention, not a sandbox. Follow the enforced
workspace boundary and negative-read checks in [the main protocol](../../README.md)
before any agent evaluation. The curating sessions that read answers cannot be reused
as evaluated sessions.
