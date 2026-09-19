# JevGrep

JevGrep is a planned semantic code-search tool for coding agents. The agent asks a question; JevGrep evaluates authorized code fragments with Jev and returns original excerpts under a response budget; the agent continues its investigation.

**Project status:** specification and implementation plan. No CLI, server, or application code exists yet.

- [Full product and technical specification](docs/specification.md) — scope, interfaces, source handling, evaluation, budgets, caching, failure behavior, and acceptance criteria.
- [Implementation plan](docs/implementation-plan.md) — phases, dependencies, deliverables, tests, and benchmark/release gates.
- [Implementation issues (French)](docs/issues.md) — 30 actionable issues with recommended experience levels, owners, reviewers, dependencies, and acceptance criteria.
- [Three-person workflow (French)](docs/workflow-equipe.md) — junior, intermediate, and senior responsibilities; parallel work, handoffs, reviews, and integration gates.
- [Decisions and alternatives](docs/decisions.md) — user-confirmed choices, accepted engineering baseline, and open empirical questions.
- [Domain language](CONTEXT.md) — the project's terms.
- [Jev research](docs/research/jev.md), [MCP/Codex integration research](docs/research/integration.md), and [independent design review](docs/research/design-review.md) — supporting evidence, primary sources, and edge cases.

Confirmed direction: personal MVP, TypeScript, JS/TS-first, repositories up to approximately 100,000 lines as the target workload, and complete-scan preflight when configured limits apply. Optional spending and total-scan caps are disabled by default; response budgets and execution timeouts are adjustable. JevGrep runs locally and sends eligible excerpts to a configured remote Jev provider.

The specification is authoritative for proposed behavior. Research notes contain dated observations and design alternatives, not additional product requirements. Performance improvements remain to be measured.
