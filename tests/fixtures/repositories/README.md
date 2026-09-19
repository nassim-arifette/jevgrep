# JG-003 synthetic repositories

These fixtures are original test data created for JevGrep. They contain no real
credentials or third-party source and are authorized for local and remote test
evaluation.

- `access-gateway` covers top-level wiring, role policy, tests, JSON configuration,
  an ignored generated directory, intentionally malformed TypeScript and inert text
  that resembles an instruction.
- `subscription-cache` covers cross-file event decoding, cache invalidation and a
  behavioral test.
- `migration-audit` covers TypeScript, JSON configuration and SQL migration content.

The fixtures exercise provider and source-pipeline tests; they are not the retrieval
benchmark's answer key. JG-027 owns the separately versioned corpus under
`benchmarks/`.
