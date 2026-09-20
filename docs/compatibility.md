# Compatibility matrix (JG-026)

What was **actually executed** for this MVP, on which runtime, and what remains unverified.
Claims here are limited to commands that ran; an unverified integration is labelled as such.

## Verified on this machine (Windows 11 + WSL interop, 2026-09-19/20)

| Component | Version | How it was verified |
| --- | --- | --- |
| Node.js | 24.15.0 (`.nvmrc`) | `node --version`; `npm ci` then `npm run verify` |
| npm | 11.12.1 | `npm --version` |
| TypeScript | 7.0.2 (pinned, `devDependencies`) | `npm run typecheck`, `npm run build` |
| Syntax parser | `typescript-parser` = `npm:typescript@6.0.2` (pinned runtime alias) | syntax-only AST, fallback/coverage fixtures and packaged installation; no repository plugins or type checking |
| Reference tokenizer | `tiktoken` 1.0.22 (pinned runtime dependency) | `npm run verify`; pinned because it is loaded at start-up |
| Vercel AI SDK | `ai` 7.0.107 (pinned runtime dependency) | offline Gateway adapter and provider-selection tests; no credential or live call |
| Vercel Gateway provider | `@ai-sdk/gateway` 4.0.87 (pinned runtime dependency) | offline adapter tests; live calls are enabled but still unverified |
| Operating system | Windows 11 (NTFS checkout, Windows Node) | full suite: 460 tests, 458 pass, 2 platform skips; eight smoke checks |
| Package artifact | `npm pack` → tarball installed into a clean prefix | `tests/install-artifact.test.ts` (pack, install `--offline`, run the installed entry point) |

## Verified on Linux

| Component | Version | How it was verified |
| --- | --- | --- |
| Node.js | 24.15.0 (official Linux tarball) | frozen sources, `npm ci`, `npm run verify`: 460 tests, 457 pass, 3 Windows-only skips |
| npm | 11.12.1 | same run |
| Package artifact | tarball built from the same frozen sources | `npm pack` + offline install into a clean prefix inside the copy |

The full runs cover code commit `e2f1b77` with the documentation update. The final
CLI adjustment `1a8e2b7` was checked separately on both systems: 12 command tests,
type checking, build and eight smoke checks. See [handoff](handoff.md) for the skip
reasons and remaining external qualification.

Continuous integration (`.github/workflows/ci.yml`) runs `npm ci` then `npm run verify` on
`ubuntu-latest` and `windows-latest` with the Node version from `.nvmrc`. **The workflow has not
run yet**: this repository has no remote, so both platforms above were reproduced locally and
the workflow itself is unproven.

## Not verified — do not claim otherwise

| Area | Status |
| --- | --- |
| Codex (or any MCP client) end-to-end | **Unverified.** No real client run has happened; `tests/mcp-server.test.ts` drives the stdio server directly. The client's outer time-out and output truncation are therefore untested; the guide states the intended margin (`docs/install-guide.md`). |
| Provider account behaviour (real Jev) | **Unverified.** Live calls are enabled after explicit repository authorization, remote enablement and credential checks, but no credential has been used in the recorded verification. TypeSafe direct remains documentation- and simulation-tested; the first live run is intended through Vercel AI Gateway. |
| MCP SDK | **Not used.** The development transport implements stdio JSON-RPC directly (`src/mcp.ts`); SDK selection was not pinned because no compatible SDK release was verified. |
| Linux artifact with a system Node from a distribution package | **Unverified.** Only the official Node tarball was used. |
| macOS | **Unverified.** |
| Response size actually accepted by Codex | **Unmeasured.** The response budget is enforced by the local reference counter, which is not the client's tokenizer. |

## Reproducing this table

```bash
npm ci
npm run verify            # typecheck, tests, build, smoke
npm run corpus:check      # corpus annotations and fingerprints
node --test tests/install-artifact.test.ts   # packaged artifact in a clean prefix
```

`docs/handoff.md` records the current qualification state; `docs/research/jev-contract-update.md`
records which provider facts are documented rather than measured.
