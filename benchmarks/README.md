# JevGrep retrieval corpus (JG-027)

Search questions with annotated reference evidence, used to measure retrieval quality
(specification §11.2) and to feed the deterministic fixtures of other issues.

**Status: first slice, protocol draft v0.1, awaiting S review.** One fixture
(`orders-api`) is annotated with 13 questions. The closure targets of JG-027 — at least
three JS/TS fixtures, 30 behavior questions, 10 exact-symbol controls, and a versioned
held-out split — are not reached yet; `npm run corpus:check` prints the remaining counts.

## Layout

```text
benchmarks/
  README.md                     this protocol
  fixtures/
    orders-api/                 author-owned JS/TS fixture repository (source material)
  manifests/
    development/
      orders-api.development.json
    holdout/                    versioned question set without public answers
  tools/
    corpus-check.ts             validates fingerprints, ranges and split rules
```

## What a corpus entry contains

A **question** is a search question in the sense of [CONTEXT.md](../CONTEXT.md): an
information need about behavior, responsibility or concept, not an instruction to modify
code. Each question records:

| Field | Meaning |
| --- | --- |
| `id` | `<fixture>.<split>.<number>`, stable and unique across the corpus. |
| `kind` | `behavior` (a described behavior must be located), `symbol_control` (an exact identifier is already known and the agent should not need a semantic search), or `no_evidence` (the fixture contains no supporting evidence). |
| `question` | The wording submitted to the tool, kept verbatim. |
| `scope` | Requested scope for the question, relative to the fixture root. |
| `expected_evidence` | Reference ranges: `path`, inclusive `start_line`/`end_line`, `role`, and a note. |
| `alternative_evidence_sets` | Other ranges that would also answer the question, for example a second implementation. |
| `ambiguous` | `true` when annotators disagree or several implementations exist; requires alternative evidence or review notes. |
| `review_notes` | Reviewer-facing explanation. Never shown to the evaluated agent. |

Evidence is annotated as **ranges and roles**, never as bare filenames. Roles:

- `direct` — the range itself carries the answer (definition, registration, migration, decision).
- `supporting` — a second range needed to complete the answer in cross-file questions.
- `context` — related material whose absence would mislead (for example a legacy duplicate).

## Verification rules (`npm run corpus:check`)

The checker is dependency-free and runs in the ordinary offline suite
(`tests/corpus.test.ts`):

1. Every manifest declares `schema_version`, a fixture with `license` and
   `authorization`, a `split`, and questions.
2. `fixture.revision.value` is the fixture fingerprint (`tree-sha256`). The checker
   recomputes it over sorted relative paths and per-file content hashes with CRLF
   normalisation. **Any edit to a fixture invalidates its annotations until they are
   reviewed again**, which is the intended behaviour: `node benchmarks/tools/check-corpus.ts
   --hash benchmarks/fixtures/<id>` prints the new value.
3. Every evidence range exists, uses forward slashes, stays inside its fixture, and has
   `1 <= start_line <= end_line <= line count`. Ranges may not start or end on a blank line.
4. `no_evidence` questions declare no expected evidence; `behavior` and `symbol_control`
   questions declare at least one range. A `symbol_control` question must quote the
   identifier in backticks and the first expected range must contain it.
5. `ambiguous: true` requires alternative evidence or review notes.
6. A held-out manifest may not contain `expected_evidence`, `alternative_evidence_sets`
   or `review_notes`; it points to `answers_ref` instead. Reference answers stay outside
   the working tree an evaluated agent can read (JG-027 acceptance criterion 5).
7. Fixture directories without a manifest, and manifests whose file name does not match
   `<fixture>.<split>.json`, are defects.

Progress towards the JG-027 targets is reported as notes, not as defects, while the issue
is open.

## Procedure

1. Choose or author a fixture (`fixtures/<id>`). Author-owned fixtures record their
   provenance in `LICENSE` and in `fixture.license`/`fixture.authorization`; a third-party
   repository needs its upstream revision, licence and the operator's authorization
   recorded before any question is annotated.
2. Write questions from a stated information need, with the scope the asker would
   plausibly use. Keep the wording verbatim, including imprecision.
3. Annotate the ranges by reading the fixture, then run
   `node benchmarks/tools/check-corpus.ts --hash benchmarks/fixtures/<id>` and store the
   fingerprint.
4. Run `npm run corpus:check` and `npm test`.
5. Ask S to review new questions and, at minimum, every `ambiguous` case and every
   `no_evidence` case. Ambiguity is recorded, never resolved by silently deleting a range.

## Open questions for the S review (protocol v0.1)

1. **Role vocabulary**: is `direct`/`supporting`/`context` enough, or is a separate
   "useful but incomplete" role needed for ranges that only expose part of a behavior?
2. **Granularity**: ranges are line intervals today. Should a reference mark a fragment
   boundary once the chunker contract (JG-015) exists, or stay independent of chunking as
   the issue requires ("indépendantes des réglages choisis pour le moteur")?
3. **Held-out split**: the draft stores questions in the repository and answers in
   `answers_ref` outside the checkout. Confirm that this satisfies acceptance criterion 5,
   including for the paired agent tasks of JG-029.
4. **Third-party fixtures**: do we authorize at least one real public repository (with
   licence and revision recorded) for realism, or keep all three fixtures author-owned?
5. **Negative evidence**: are two `no_evidence` questions per fixture enough to detect
   fabricated answers, and should they be paired with a lexical-search control?
6. **Budget recording**: question-level `budget` is not part of the manifest yet. Should
   the response budget and deadline be recorded per question (comparable runs) or per
   benchmark run by JG-028?

## Commands

```bash
npm run corpus:check                                            # validate the corpus
node benchmarks/tools/check-corpus.ts --hash benchmarks/fixtures/orders-api
```
