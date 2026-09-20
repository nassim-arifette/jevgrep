# JevGrep

JevGrep helps coding agents find relevant code when they do not know the file name or
symbol to search for.

Ask a question such as “Where is session expiry handled?” and JevGrep scans the
authorized repository, asks Jev to score all eligible fragments, then returns the
original source excerpts with their paths and line numbers. The calling agent can read
those files in detail and continue its work with less exploratory context.

> JevGrep is an experimental project being prepared for an open-source release. It is ready
> for local testing, but its retrieval quality and live provider behaviour have not been
> benchmarked broadly yet.

## What it is for

JevGrep is useful when a coding agent needs to:

- locate behaviour without knowing the exact identifier;
- understand a feature spread across implementation, configuration and tests;
- reduce the amount of repository exploration placed in the agent's main context;
- retrieve exact source excerpts instead of a generated summary.

It complements exact tools such as `rg`. If you already know the symbol or literal,
ordinary text search is usually faster.

## Requirements

- Node.js 24
- npm
- a TypeSafe AI key or a Vercel AI Gateway key

JevGrep searches every valid UTF-8 text file, regardless of repository language or
extension. JavaScript and TypeScript additionally receive syntax-aware chunking; all
other text uses bounded line windows.

## Install from the repository

The package is not published to npm yet. Install the current checkout locally:

```bash
npm ci
npm run build
npm link
jevgrep --version
```

`npm link` makes the `jevgrep` command available from any directory on the computer.

## Quick start

### 1. Configure a provider

Configure the provider and key once for the computer:

```bash
jevgrep init --global
```

TypeSafe AI is proposed first. To use Vercel AI Gateway instead:

```bash
jevgrep init --global --provider vercel
```

The command stores the credential in the user's JevGrep configuration directory, not
in a repository. `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` environment variables take
priority over the stored value.

### 2. Authorize a repository

Run `init` once from the repository root:

```bash
cd path/to/my-project
jevgrep init
```

The default root is the current directory. You can also provide it explicitly:

```bash
jevgrep init --root path/to/my-project
```

Provider credentials are global, but repository authorization is not. Each repository
must be authorized separately. Its trusted profile is stored outside the repository.
New profiles keep remote evaluation disabled.
`init` also creates a commented `.jevgrepignore` in the repository when one does not
already exist. Existing exclusions are preserved; `.gitignore` is already respected.

### 3. Inspect before sending code

```bash
jevgrep doctor
jevgrep inspect
```

`doctor` checks the selected provider, credential state, authorized root, limits and
cache without making a network request.

`inspect` shows which files and fragments are eligible, what was excluded and how much
work a search would perform. It also stays offline.

After reviewing the scope and limits, edit the profile path printed by `init` and set
`remote_evaluation_enabled` to `true` to allow source disclosure to the selected provider.

### 4. Search by behaviour

```bash
jevgrep search --query "Where is session expiry handled?"
```

Useful options:

```bash
# Search only selected directories
jevgrep search --query "How are permissions checked?" --scope src --scope tests

# Return the canonical JSON response
jevgrep search --query "Where is the cache invalidated?" --json

# Read a multiline question from a file
jevgrep search --query-file question.txt

# Allow a deterministic partial scan when an enabled scan cap is exceeded
jevgrep search --query "How does synchronization work?" --allow-partial
```

JevGrep automatically finds the authorized project for the current directory, including
when the command runs from a subdirectory. `--config <path>` remains available as an
explicit override.

## Providers

| Provider | Setup | Model |
| --- | --- | --- |
| TypeSafe AI | `jevgrep init --global --provider typesafe` | `jev-latest` |
| Vercel AI Gateway | `jevgrep init --global --provider vercel` | `typesafe-ai/jev` |

The TypeSafe transport follows the documented System One HTTP contract and is covered
with simulated responses. It has not been tested against a real account in this project.
Vercel AI Gateway is the intended path for the first live tests.

To switch an existing global and project profile to Vercel:

```bash
jevgrep init --global --provider vercel
jevgrep init --provider vercel
```

## Use with coding agents

JevGrep exposes the same search engine through a stdio MCP server:

```bash
jevgrep mcp
```

The server exposes one tool, `semantic_search_code`. Starting it does not scan files or
contact a provider. A tool call performs a search using the authorization associated
with the current directory.

For Codex, Claude Code or another MCP client, configure a stdio server that runs
`jevgrep mcp` with the repository as its working directory. If the client cannot set a
working directory, pass the absolute profile path printed by `jevgrep init`:

```json
{
  "mcpServers": {
    "jevgrep": {
      "command": "jevgrep",
      "args": ["mcp", "--config", "C:/Users/me/AppData/Roaming/jevgrep/profiles/my-project-<hash>/config.json"]
    }
  }
}
```

The exact MCP configuration location depends on the client. See the
[installation guide](docs/install-guide.md) for more detail.

## What leaves your computer

Search evaluation is remote. When you run `jevgrep search`, eligible source fragments
are sent to the configured provider together with:

- your search question;
- repository-relative paths and line ranges;
- the relevance criterion used for scoring.

JevGrep excludes common credential files, `.env` files, dependencies, build output,
generated files, minified files and files that match credential patterns. Links and
junctions are not followed. Run `jevgrep inspect` to review the eligible scope before
the first live search.

The credential is never placed in the search payload, result or cache. Redirects are
not followed by either transport. Provider retention and privacy policies
still apply to anything sent remotely.

## Results and exit codes

Human-readable output is the default. Pass `--json` for the validated response contract.
The result includes coverage information, exclusions, stop reasons and exact excerpts,
so an empty or partial result is not presented as proof that code does not exist.

| Code | Meaning |
| --- | --- |
| `0` | complete result |
| `2` | invalid request, configuration problem or rejected preflight |
| `3` | partial result |
| `4` | fatal runtime failure |
| `130` | interrupted |

Results go to stdout. Diagnostics and measurements go to stderr.

## Cache

JevGrep caches provider scores outside the repository. Repeating an identical search can
reuse evaluations when the pinned model revision, criterion, complete request batch,
source fragment and question are unchanged. Unresolved aliases (`jev-latest` and the
Gateway model alias) currently disable persistent reuse.

Clear the cache for the current project with:

```bash
jevgrep cache clear
```

Cached entries contain scores and identities, not source text, questions or credentials.

## Current limitations

- The project is experimental and has not completed broad real-world benchmarks.
- TypeSafe direct has only been tested against documentation and simulated responses.
- Vercel live evaluation is enabled but still needs its first recorded end-to-end run.
- MCP transport is tested locally, but Codex and Claude interoperability still needs to
  be qualified with real clients.
- JavaScript and TypeScript receive the best source chunking today.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

Run the complete local verification gate with:

```bash
npm run verify
```

The test suite is offline and does not use provider credentials.

## Documentation

- [Installation and troubleshooting](docs/install-guide.md)
- [Product and technical specification](docs/specification.md)
- [Public contracts](docs/contracts.md)
- [Implementation plan](docs/implementation-plan.md)
- [Provider research](docs/research/jev.md)
- [Current project handoff](docs/handoff.md)

## License

No open-source license has been selected yet. The repository is currently marked
`UNLICENSED`; choose and add a license before presenting it as reusable open-source
software.
