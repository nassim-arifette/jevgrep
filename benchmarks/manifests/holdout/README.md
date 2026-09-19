# Held-out questions

The held-out split is versioned here as **questions and provenance only**. Reference
evidence, alternative evidence and review notes for these questions live outside the
working tree an evaluated agent can read; each manifest points to them through
`answers_ref` (JG-027 acceptance criterion 5, specification §11.2).

`benchmarks/tools/corpus-check.ts` enforces this: a manifest under this directory is a
defect if it contains `expected_evidence`, `alternative_evidence_sets` or `review_notes`.

The split is frozen before any threshold, fragment size or batching tuning (JG-028).
