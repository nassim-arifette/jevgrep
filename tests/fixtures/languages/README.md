# Golden language fixtures

Per-profile golden fixtures (language search spec 9.2). Each records the exact
fragments the production chunker returns for a small source file, so a change to a
language profile shows up as a reviewed diff of ranges and labels.

```text
tests/fixtures/languages/<profile>/<case>.<ext>        source file, checked in as is
tests/fixtures/languages/<profile>/<case>.<ext>.json   expected chunk result
```

`<profile>` is the language profile (`javascript` covers JS and TS, as in
`SYNTAX_CHUNKER_VERSIONS`). The extension picks the chunker exactly as for a search.

```json
{
  "description": "What the case covers and why.",
  "limits": { "targetTokens": 20, "maxTokens": 400 },
  "strategy": "syntax",
  "fallback": null,
  "fragments": [
    { "lines": [1, 2], "label": null },
    { "lines": [3, 8], "label": "struct:Account" },
    { "lines": [9, 40], "label": "function:run", "declaration": [9, 70] }
  ]
}
```

- `limits` (optional) overrides fields of `DEFAULT_WINDOW_LIMITS`; a small token
  target makes a short file show its declaration boundaries.
- `strategy` and `fallback` are the chunk result's (`fallback` is `"parse_failure"`
  when a syntax error sent the file to line windows).
- `fragments` lists every fragment in order: inclusive 1-based `lines`, the
  model-visible `label` (or `null`) and, only when the chunker sets it, the
  `declaration` range a split fragment was cut from.

[`tests/helpers/language-fixtures.ts`](../../helpers/language-fixtures.ts) runs a case:
it chunks the source, checks the invariants (exact slices, every non-blank line
covered) and compares the result with the JSON. `tests/language-fixtures.test.ts`
runs every case in this directory. After an intended chunker change, regenerate the
expected files and review the diff:

```sh
JEVGREP_UPDATE_LANGUAGE_FIXTURES=1 node --test tests/language-fixtures.test.ts
```

The seeds, one per current syntax language, record `main` as of `09b0669` on
plain declarations. Spec 9.2 asks each profile to grow to cover leading trivia,
nested containers, an oversized callable, an oversized statement, one local syntax
error and the constructs of its section 4 entry; a defect fix adds its case here.
Phase 1 (shared planner, LS-1 to LS-3 and LS-8) added `go/nested.go`, `rust/nested.rs`
(leading trivia, carried headers, an oversized callable split recursively, declaration
ranges) and `go/recovery.go`, `rust/recovery.rs` (one local syntax error).
Files are indented with spaces (the repository's format check rejects tab
indentation, including in the Go fixture).
