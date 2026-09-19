# JevGrep

JevGrep is a planned semantic code-search tool for coding agents. The agent asks a question; JevGrep evaluates authorized code fragments with Jev and returns original excerpts under a response budget; the agent continues its investigation.

**Project status:** implementation has started. The TypeScript/CLI scaffold and the
first offline test infrastructure exist, but repository inspection, search, provider
integration, cache and MCP are not implemented yet.

- [Full product and technical specification](docs/specification.md) — scope, interfaces, source handling, evaluation, budgets, caching, failure behavior, and acceptance criteria.
- [Implementation plan](docs/implementation-plan.md) — phases, dependencies, deliverables, tests, and benchmark/release gates.
- [Implementation issues (French)](docs/issues.md) — 30 actionable issues with recommended experience levels, owners, reviewers, dependencies, and acceptance criteria.
- [Three-person workflow (French)](docs/workflow-equipe.md) — junior, intermediate, and senior responsibilities; parallel work, handoffs, reviews, and integration gates.
- [Decisions and alternatives](docs/decisions.md) — user-confirmed choices, accepted engineering baseline, and open empirical questions.
- [Domain language](CONTEXT.md) — the project's terms.
- [Jev research](docs/research/jev.md), [MCP/Codex integration research](docs/research/integration.md), and [independent design review](docs/research/design-review.md) — supporting evidence, primary sources, and edge cases.

Confirmed direction: personal MVP, TypeScript, JS/TS-first, repositories up to approximately 100,000 lines as the target workload, and complete-scan preflight when configured limits apply. Optional spending and total-scan caps are disabled by default; response budgets and execution timeouts are adjustable. JevGrep runs locally and sends eligible excerpts to a configured remote Jev provider.

The specification is authoritative for proposed behavior. Research notes contain dated observations and design alternatives, not additional product requirements. Performance improvements remain to be measured.

## Development

Runtime: Node.js 24.15.0 LTS, pinned in [`.nvmrc`](.nvmrc); `package.json` accepts `>=24.0.0 <25.0.0`. One package, no monorepo framework. TypeScript and Node type definitions are the only dependencies, both pinned exactly and both in `devDependencies`.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact versions recorded in `package-lock.json`. |
| `npm run typecheck` | Strict type check over `src`, `tests` and `scripts`; any type error exits non-zero. |
| `npm test` | Offline test suite: no provider key, no network call. |
| `npm run build` | Emit the CLI to `dist/` and make it executable on POSIX. |
| `npm run smoke` | Run the built CLI and check its documented exit codes (needs `npm run build` first). |
| `npm run verify` | `typecheck` + `test` + `build` + `smoke`; this is the CI gate. |

Run the CLI from source with `node src/cli.ts --help`. The build emits `dist/cli.js`, which is the `jevgrep` bin entry; `npm link` exposes it locally.

Tests use Node's built-in test runner on `tests/*.test.ts` and
`tests/contract/*.test.ts`. These explicit suite roots keep fixture repositories under
`tests/fixtures/` as search material: their own `*.test.ts` files never run as part of
the project suite. Node 24 strips TypeScript types natively and `tsconfig.json` enables
`erasableSyntaxOnly`, so no transpiler and no test framework are installed.

`.nvmrc` pins the exact patch release used by CI (24.15.0) while `engines` accepts any Node.js 24.x; only the major version is enforced by the test suite. The CI workflow (`.github/workflows/ci.yml`) runs `npm ci` then `npm run verify` on `ubuntu-latest` and `windows-latest`. It has not run yet: this repository has no git remote, so the workflow has only been reproduced locally on both platforms.

Spawned CLI processes run with an offline preload (`tests/helpers/offline-preload.ts`), which turns any provider call into a loud failure. `NODE_OPTIONS` does not survive the WSL-to-Windows boundary, so probe it from Node, not from a WSL shell.

The gate artifact of `tests/type-check-gate.test.ts` is `tests/__type_check_gate__.ts`: it holds one deliberate type error while the check runs, is deleted again (also at the start of the next run) and is not gitignored, so an interrupted run leaves something visible and harmless rather than a broken `src/` file.

Current CLI surface: `jevgrep --help` and `jevgrep --version` work. `search`, `inspect`, `doctor`, `mcp` and `cache` are part of the specification but are not implemented yet: each one exits 69 with an explicit "not implemented in this build" message and performs no work. Exit codes follow specification §4.5: 0 complete, 2 invalid request or bad arguments, 4 fatal runtime failure (used today for an unreadable package manifest). Codes 3 (partial result) and 130 (interruption) stay reserved for the real commands.
