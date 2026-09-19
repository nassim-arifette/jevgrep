# JG-027 — senior corpus and protocol review

Date: 2026-09-19. Baseline: `4eec69b`. Scope: all 42 development annotations,
the former 12 held-out questions, the revised 12 held-out annotations, and the validator.
No fixture application was executed and no remote/provider or agent evaluation was run.

## Semantic review

The initial independent review found eight development annotations requiring correction:
discount precedence omitted evidence, HTTP formatting accepted a CSV-only duplicate,
the SQL rationale pointed at the decision instead of its reasons, two symbol ranges were
too broad/incomplete, the TTL wording implied absent configuration wiring, a scheduler
alternative escaped scope and overstated timezone behavior, and legal-hold wording
reversed the default. Each was corrected against source.

The reviewer accepted the corrected cases after one follow-up: the explicitly requested
TTL default is supporting evidence, not optional context. The remaining development
annotations, including both no-evidence cases, were read and accepted.

Ten of the former twelve held-out questions were semantic repetitions of development
questions. That split was retired before tuning. Twelve replacement questions use three
new fixtures disjoint from development. A second semantic pass accepted their source
evidence, roles, scopes and behavior descriptions. Private answers remain an operator
artifact and are not reproduced here.

## Protocol decisions

Protocol v1 retains line ranges independent of chunking, three explicit evidence roles,
complete alternative answer sets, independent annotation review and revision pinning.
All current fixtures are project-authored and UNLICENSED for public redistribution.
The corpus is synthetic and does not establish performance on real external repositories.

The previous claim that an external answer path alone isolated it from an evaluated
agent was unsupported. Manifests now store opaque IDs. Private validation is explicit
and strict when scoring. The protocol requires fresh fixture-only workspaces, enforced
filesystem separation, unreadable operator/curator sentinels, and separate scoring.
JG-028/JG-029 must execute and retain evidence of these checks before any result is valid.

## Executable checks

The 35 corpus tests cover public/private reference validation, scope membership,
alternatives and roles, disjoint splits, exact identifiers, stale revisions, missing and
orphan answers, links, explicit answer selection and outside-workspace storage.
The operator check with the private v2 answer set passes all six fixture fingerprints
and 54 questions. Ordinary CI reports the three private answer sets as not checked.

Senior review of the corpus and protocol is complete. The corpus is ready for the
benchmark runner; operational isolation and measured results are not yet delivered.
