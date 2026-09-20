# JevGrep

**Find code by what it does.** JevGrep helps coding agents find relevant code when
they do not know the file name or symbol to search for.

Ask a question such as “Where is session expiry handled?” and JevGrep scans the
authorized repository, asks Jev to score all eligible fragments, then returns the
original source excerpts with their paths and line numbers. The calling agent can read
those files in detail and continue its work with less exploratory context.

Use the CLI or connect a coding agent
through the local MCP server.

## Demos

### CLI

![Initialize JevGrep, approve remote evaluation, and search source code from the terminal](docs/assets/jevgrep-cli-demo.gif)

### MCP

![Files explored without JevGrep compared with the relevant source located through JevGrep](docs/assets/jevgrep-tree-demo.gif)

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
- a TypeSafe AI, Vercel AI Gateway or OpenRouter API key

JevGrep searches every valid UTF-8 text file, regardless of repository language or
extension.

## Install

Install the public package from npm:

```bash
npm install -g @nassim-arifette/jevgrep
jevgrep --version
```

The unscoped package name `jevgrep` belongs to a different project. Use the complete
scoped name above when installing. The installed command is still `jevgrep`.

Package: [@nassim-arifette/jevgrep](https://www.npmjs.com/package/@nassim-arifette/jevgrep)

To install a development checkout instead:

```bash
git clone https://github.com/nassim-arifette/jevgrep.git
cd jevgrep
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

To use OpenRouter:

```bash
jevgrep init --global --provider openrouter
```

The command stores the credential in the user's JevGrep configuration directory, not
in a repository. `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY` and `OPENROUTER_API_KEY`
environment variables take priority over the corresponding stored value.

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
Interactive `init` asks before enabling remote evaluation for this repository:

```text
Allow sending eligible source excerpts from this repository to Vercel AI Gateway? [y/N]
```

Answer `y` to search immediately. Enter or `n` keeps remote evaluation disabled.
Non-interactive initialization also leaves new profiles disabled. Optional scan caps are disabled by default;
configure them if you want to limit usage.
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

If you did not enable remote evaluation during `init`, review the scope and limits,
then edit the profile path printed by `init` and set
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

| Provider          | Setup                                       | Model                 |
| ----------------- | ------------------------------------------- | --------------------- |
| TypeSafe AI       | `jevgrep init --global --provider typesafe` | `jev-1.13.0` (pinned) |
| Vercel AI Gateway | `jevgrep init --global --provider vercel`   | `typesafe-ai/jev`     |
| OpenRouter        | `jevgrep init --global --provider openrouter` | `typesafe/jev-1.13` |

The TypeSafe transport follows the documented System One HTTP contract and is covered
with simulated responses. It has not been tested against a real account in this project.
Vercel AI Gateway has been checked on a small authentication example, including a
repeat search served entirely from the score cache.

OpenRouter uses its alpha Decisions endpoint, `POST https://openrouter.ai/api/alpha/decisions`,
with Bearer authentication and structured Noul questions. The adapter supplies both
`true` and `false` criteria, reads `answers[id].noul`, `usage.input_tokens`,
`usage.output_tokens` and the response `id`, and disables provider fallback.
Its request and response handling were reviewed against the
[official OpenRouter OpenAPI specification](https://openrouter.ai/openapi.json)
(`DecisionsRequest`, `DecisionsNoulQuestion`, `DecisionsResponse`) on 2026-09-20.
No live OpenRouter request or automated test was run for this integration.
The alpha API may change. See the [Jev model page](https://openrouter.ai/typesafe/jev-1.13)
and [OpenRouter configuration example](docs/examples/jevgrep.openrouter.config.json).

To switch an existing global and project profile to Vercel:

```bash
jevgrep init --global --provider vercel
jevgrep init --provider vercel
```

Use `--provider openrouter` in both commands to switch to OpenRouter.

## Use through MCP

JevGrep exposes the same search engine through a stdio MCP server:

```bash
jevgrep mcp
```

The server exposes one tool, `semantic_search_code`. Starting it does not scan files or
contact a provider. A tool call performs a search using the authorization associated
with the current directory.

Configure and authorize the repository first. One server process serves one repository.
Use the absolute profile path printed by `jevgrep init` so the server does not depend
on the client's working directory. Replace the example paths below.

### Claude Code

After installing JevGrep:

```bash
claude mcp add --transport stdio jevgrep -- jevgrep mcp --config "/absolute/path/to/config.json"
```

Check `claude mcp get jevgrep` and `/mcp` in Claude Code. See the
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Codex

Add an entry to your Codex `config.toml`:

```toml
[mcp_servers.jevgrep]
command = "jevgrep"
args = ["mcp", "--config", "/absolute/path/to/config.json"]
tool_timeout_sec = 360
```

The suggested client timeout leaves a margin over JevGrep's default 300-second search
deadline. Adjust both for your workload. See the
[Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Other clients

For clients that accept `mcpServers` configuration:

```json
{
  "mcpServers": {
    "jevgrep": {
      "command": "jevgrep",
      "args": ["mcp", "--config", "/absolute/path/to/config.json"]
    }
  }
}
```

Credentials saved by `init --global` are available to clients running as the same OS
user. Environment keys must be available to the client process. Do not commit keys
in MCP configuration.

If the client cannot find `jevgrep` or launch an npm shim on Windows, use absolute
paths to `node` and the installed `dist/cli.js`. See the
[installation guide](https://github.com/nassim-arifette/jevgrep/blob/main/docs/install-guide.md#connect-an-mcp-client).

These examples have not yet been qualified with real Codex and Claude Code sessions.
Confirm that your client lists `semantic_search_code` and completes a search.

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

Credential filters cannot detect every secret; add repository-specific exclusions in
`.jevgrepignore` where needed.

The credential is never placed in the search payload, result or cache. Redirects are
not followed by either transport. Provider retention and privacy policies
still apply to anything sent remotely.

## Results and exit codes

Human-readable output is the default. Pass `--json` for the validated response contract.
The result includes coverage information, exclusions, stop reasons and exact excerpts,
so an empty or partial result is not presented as proof that code does not exist.

| Code  | Meaning                                                      |
| ----- | ------------------------------------------------------------ |
| `0`   | complete result                                              |
| `2`   | invalid request, configuration problem or rejected preflight |
| `3`   | partial result                                               |
| `4`   | fatal runtime failure                                        |
| `130` | interrupted                                                  |

Results go to stdout. Diagnostics and measurements go to stderr.

## Cache

JevGrep caches provider scores outside the repository, independently for each question
and fragment. Changing another fragment does not invalidate an unchanged score.
Provider, endpoint, model, query, source, location, criterion and layout remain part
of the identity. Only misses are grouped into requests.

New TypeSafe direct profiles pin `jev-1.13.0` and use the configured cache TTL (seven
days by default). Vercel's `typesafe-ai/jev` and OpenRouter's `typesafe/jev-1.13`
use the conservative rolling policy: scores can be reused for up to 15 minutes.
OpenRouter may resolve the requested model to a dated revision in its response;
the version alias is not treated as an immutable cache identity. Existing direct profiles
using `jev-latest` or `jev-preview` use the same short-lived policy.

Rolling reuse can briefly serve a score from an earlier model revision. `doctor`
shows this policy and its effective TTL. Set `cache.rolling_ttl_seconds` to `0` to
disable it, or to an integer from `1` to `900` to shorten it. `cache.enabled: false`
disables all score reuse. Existing profiles do not need to be recreated.

Clear the cache for the current project with:

```bash
jevgrep cache clear
```

Cached entries contain scores and identities, not source text, questions or credentials.

## Request batching

Fragments remain small enough to return precise excerpts. Requests pack fragments by
the estimated tokens in the complete serialized payload, including the query, criteria
and metadata.

| Transport         | Aggregate ceiling used                    | Target with tokenizer headroom |
| ----------------- | ----------------------------------------- | ------------------------------ |
| TypeSafe direct   | 64,000 tokens                             | 44,800 reference tokens        |
| Vercel AI Gateway | 32,000 tokens (conservative local policy) | 22,400 reference tokens        |
| OpenRouter        | 32,000 tokens (conservative local policy) | 22,400 reference tokens        |

TypeSafe documents 64k total and 32k for shared state plus one question. Gateway and
OpenRouter advertise a 32k context; using it as an aggregate ceiling is conservative,
not a claim that they document the same total-question limit. All three paths keep
30% headroom because the provider tokenizer is not public, and locally limit each
request to 64 questions and 256 KiB. These last two limits are application safeguards.
See [TypeSafe model limits](https://docs.typesafe.ai/models) and the
[Gateway model catalog](https://ai-gateway.vercel.sh/v1/models) and
[OpenRouter Jev model page](https://openrouter.ai/typesafe/jev-1.13).

`inspect` and search planning use the same serializer and token estimator; `inspect`
uses a sample query, so its estimate can differ from an actual search. Estimates are
not provider billing. File preparation still runs on every search: there is no
persistent repository index.

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

The test suite is offline and does not use provider credentials. There is no benchmark
suite or benchmark acceptance gate; live checks use a small, explicitly chosen example.

## Documentation

- [Installation and troubleshooting](https://github.com/nassim-arifette/jevgrep/blob/main/docs/install-guide.md)
- [Configuration examples](https://github.com/nassim-arifette/jevgrep/tree/main/docs/examples)
- [Report an issue](https://github.com/nassim-arifette/jevgrep/issues)

## License

[MIT](https://github.com/nassim-arifette/jevgrep/blob/main/LICENSE) © 2026 Nassim Arifette.
