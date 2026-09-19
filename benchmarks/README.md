# JevGrep retrieval corpus (JG-027)

Protocol **v1**, reviewed on 2026-09-19. The frozen corpus has six authored fixtures
and 54 questions: development contains 30 behavior questions, 10 exact-symbol
controls and two no-evidence questions; holdout contains 12 questions on three
different fixtures. Two development questions record ambiguity and one accepts an
alternative evidence set. See [the senior review](../docs/reviews/jg-027-review.md).

This corpus is synthetic and small. Passing it is not evidence of general retrieval
quality on third-party repositories. Fixtures are source material, not application
dependencies or executable tests. Their provenance authorizes the documented
personal-project experiments; `UNLICENSED` is not a public redistribution grant.

## Layout and revisions

- `fixtures/orders-api`, `subscription-cache`, `migration-audit`: development.
- `fixtures/lease-worker`, `upload-gateway`, `webhook-outbox`: holdout only.
- `manifests/development/*.json`: public questions and reviewed annotations.
- `manifests/holdout/*.json`: questions, provenance and an opaque answer-set ID.
- `tools/check-corpus.ts`: offline validation of both splits.
- Operator storage, outside every evaluated workspace: held-out reference answers.

The former v0.1 holdout questions were retired before tuning: changing their wording
did not make them independent of the development questions. Git history retains
the old draft. Do not score or combine those questions with v1.

Each manifest pins a `tree-sha256` fingerprint: hash the sorted relative file names,
a NUL separator, each UTF-8 file's SHA-256 after CRLF normalization, and a newline.
The final SHA-256 covers that sequence. Any fixture edit invalidates the public and
private annotations. A release run records the corpus Git commit plus each tree hash;
changing an annotation requires a new corpus revision even if sources stay unchanged.

## Annotation decisions

A search question records its verbatim wording, canonical relative `scope`, stable
`<fixture>.<split>.<number>` ID, and kind:

| Kind | Use |
| --- | --- |
| `behavior` | Locate the implementation of a described behavior or concept. |
| `symbol_control` | An exact identifier, quoted in backticks, is already known. |
| `no_evidence` | No source in the requested scope supports the stated behavior. |

Reference evidence consists of inclusive, one-based line ranges with a required role:

| Role | Meaning |
| --- | --- |
| `direct` | Carries a requested fact or behavior. |
| `supporting` | Needed to complete the answer, such as its caller or configuration binding. |
| `context` | Useful qualification; its absence alone does not make an answer incomplete. |

The primary set and each `alternative_evidence_sets` entry are complete answer sets,
not a bag of interchangeable single excerpts. A complete answer must support all
requested facts through direct/supporting evidence from one acceptable set. Context
can improve precision but cannot substitute for a missing required fact. Overlap with
a line range alone does not establish semantic sufficiency; JG-028 records its scoring
procedure and reviews disputed outputs before reporting success.

Ranges remain independent of chunk sizes and engine settings. Keep the smallest
readable range that establishes the fact; include callers/imports when the question
asks which surface uses a duplicate helper. A range must be inside the requested
scope and cannot start or end on a blank line. A second implementation is acceptable
only if it answers this question in its actual context.

`ambiguous: true` requires reviewed alternatives or an explicit explanation. The
HTTP money formatter's legacy copy alone is insufficient. The audit scheduler's
literal expression, duplicate config value and documented UTC timezone must not be
confused with actual configuration wiring or an implemented timezone guarantee.

For no-evidence questions, curators inspect every file in the stated scope, including
plausible aliases and indirect routes. Record the reasoning in private/public reviewer
notes as appropriate. No expected or alternative reference ranges may be supplied.
The two current negatives are a starting control, not an estimate of hallucination
rates. Add independently reviewed negatives with future corpus revisions.

## Separation and evaluation procedure

1. Curators read source and annotate without tuning retrieval settings. A second
   reviewer checks every new question, ambiguity and no-evidence judgment.
2. Freeze the corpus revision before choosing thresholds, fragmentation or batching.
   Use development questions for those choices. Holdout is for the declared final
   comparison; if inspected for tuning afterward, retire it from future holdout use.
3. The operator validates private answers explicitly with `--answers` and
   `--require-answers` before scoring. CI checks public structure only and reports
   that private answers were not checked.
4. The evaluated agent receives a fresh copy of just the target fixture, its question
   and scope. Never give it this checkout, manifests, reference answers, review notes,
   Git history, curator conversations or outputs from another condition.
5. Run the evaluated process with access restricted to that fixture workspace and
   approved tools. Keep the operator answer store on an unmounted/separate host or
   behind an enforced filesystem boundary. A sibling directory on the same unrestricted
   machine is **not** isolation. Before an evaluation, test that a sentinel in operator
   storage and the curator checkout cannot be read from the agent's actual environment.
   Fail the run if either check succeeds or cannot be performed.
6. Score collected outputs in a separate operator process. Do not send scoring feedback
   or answer paths to the evaluated agent. For paired tasks, use fresh workspaces/caches
   for each condition and record the isolation checks with the run manifest.
7. JG-028/JG-029 must implement and exercise those run boundaries; no agent evaluation
   has yet been executed by this corpus review. Corpus curation on this workstation
   is not an evaluated trial.

Budget, deadline, model, prompt, tool versions, cache state and ordering belong to a
benchmark-run manifest. Existing manifest-level budget values are draft hints, not
hidden product limits or evidence of measured runs. The same explicit run settings
apply to compared conditions. Public third-party fixtures can be added only after
license, revision and authorization review.

## Checks and commands

The checker uses the public search-request contract for lexical paths. It verifies
fingerprints, file ranges, roles, scope membership, alternatives, disjoint fixture
splits, unique IDs within a manifest, exact-symbol controls, and the absence of public
held-out answers. Symlink/junction entries in fixture trees are rejected. This is a
curation integrity check, not the product's JG-008 filesystem authorization boundary.

`answers_ref` is an opaque ID, never a file path. No implicit filesystem lookup is
allowed. An explicit private answer file must be outside the checkout/corpus and match
the ID and fixture revision; its ranges obey the same checks as development ranges.
Missing private answers fail `--require-answers`. Ordinary CI cannot certify private
semantic annotations, operator isolation or a scored evaluation.

```bash
npm run corpus:check
node --test tests/corpus.test.ts
node benchmarks/tools/check-corpus.ts --hash benchmarks/fixtures/orders-api
node benchmarks/tools/check-corpus.ts --answers <absolute-operator-file> --require-answers
```

The schema and operator file convention are described in
[the holdout guide](manifests/holdout/README.md).
