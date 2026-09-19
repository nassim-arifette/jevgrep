# JG-002 — Contract stabilization review

Reviewed initial commit: `958c444e38118c54ce0745c2a3758b3ab523ff21`, against `c8b4b08`, on 2026-09-19. Two independent reviewers examined Standards and Spec; the author corrected the findings and the Spec reviewer rechecked both counterexamples. References: specification §4, §7.4, §10 and R5–R10; JG-002 acceptance criteria; workflow §5–6.

## Standards

No actionable finding. The public schemas infer their types, both presentations share one serializer, validation has no I/O or added dependency, and the small private primitives serve the current contracts. No additional abstraction was justified.

## Spec

Two P2 findings in the initial commit, both corrected:

1. An unknown dispatched attempt could retain zero estimated tokens because only the known subtotal was checked. The schema now requires a positive reservation per unknown attempt, with regression cases for wholly unknown and mixed usage. This minimum check does not prove the complete conservative reservation; JG-016/017 own the per-attempt ledger.
2. An early `INVALID_REQUEST` or `INVALID_CONFIG` reason could validate as `partial`, causing MCP to return `isError=false`. Such reasons, and the other early-rejection codes, now require rejection. Regression tests cover all seven early codes.

The independent follow-up reproduced the original counterexamples: they are now rejected, valid fixtures remain accepted, and all 54 focused result-contract tests pass. The other JG-002 contracts match the specification. Real tokenizer selection, filesystem authorization and engine/transport integration remain their dedicated issues.

## Validation and disposition

Node 24.15.0 on Windows. The author ran all 70 contract tests plus the corrected simulator/fixture tests (81 combined), and `npm run typecheck`; all passed. The full project gate had passed on the initial contract commit as well. No provider calls or credentials were involved.

Standards: 0 findings. Spec: 2 original findings, 2 corrected and independently verified. No remaining blocker for the JG-002 contract baseline; JG-003 may now be integrated against it.
