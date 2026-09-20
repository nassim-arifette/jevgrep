# JevGrep installation and configuration guide

JevGrep runs locally and evaluates eligible source fragments remotely with TypeSafe AI
or Vercel AI Gateway. This guide covers installation, repository authorization and MCP.

## Install

Requires Node.js 24 and npm. The package name is `@nassim-arifette/jevgrep`;
the unscoped package `jevgrep` belongs to a different project. Until the first npm
release, install from this repository.

From this repository:

```bash
git clone https://github.com/nassim-arifette/jevgrep.git
cd jevgrep
npm ci
npm run build
npm link
jevgrep --version
```

After publication, install it with:

```bash
npm install -g @nassim-arifette/jevgrep
```

For development checks, run `npm run verify`. Runtime dependencies are
`@ai-sdk/gateway`, `ai`, `tiktoken` and `typescript-parser`; exact versions are in
[package.json](../package.json). The tokenizer vocabulary ships with its package.

## Configure a provider

Run the interactive setup once for your OS user:

```bash
jevgrep init --global
```

To select Vercel explicitly:

```bash
jevgrep init --global --provider vercel
```

Credentials are stored in the user's JevGrep configuration directory, outside the
repository. `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` override stored credentials.
Use environment variables in automated environments; do not commit keys in project files.

New direct profiles use `jev-1.13.0`; Vercel profiles use `typesafe-ai/jev`.
To switch an existing project, run the corresponding global setup, then
`jevgrep init --provider vercel` (or `--provider typesafe`) inside that project.
Existing limits and the disclosure setting are preserved.

## Authorize a repository

```bash
cd path/to/your-project
jevgrep init
jevgrep doctor
jevgrep inspect
```

You can use `jevgrep init --root "/absolute/path/to/project"` instead.
Each repository needs its own authorization. The trusted profile is stored outside
the repository, and `init` prints its path. The command also creates a commented
`.jevgrepignore` when none exists; existing exclusions are preserved.

New profiles set `remote_evaluation_enabled` to `false`. Both `doctor` and
`inspect` work offline without a provider key. Review the eligible scope, exclusions
and limits, then edit the printed profile and set:

```json
"remote_evaluation_enabled": true
```

With a valid credential and authorization, searches can now contact the provider.

For manual configuration, copy the [example profile](examples/jevgrep.config.json)
outside the repository, set its absolute `repository_root`, and pass its path using
`--config`. The configuration file cannot live inside the root it authorizes.

## What leaves your machine

Search sends eligible fragment text, your question, relative paths, line ranges and
the relevance criterion to the configured provider. The evaluation runs remotely.

The source policy excludes common credential files, the `.env` family, dependencies,
build output, generated and minified artifacts, and files containing detected credential
patterns. Links and junctions are refused. Filters cannot detect every secret;
review `inspect` output and add exclusions in `.jevgrepignore` when needed.

Credentials authenticate requests and are not placed in evaluation content or cache
entries. Both transports refuse redirects. Provider retention and privacy policies
apply to disclosed content; JevGrep does not promise zero retention.

## Limits and cache

| Setting | Default | Meaning |
| --- | --- | --- |
| `scan_caps.*` | `null` | optional caps disabled; `0` is a real zero allowance |
| `search.deadline_ms` | `300000` | five minutes, including preparation and queue wait |
| `search.concurrency` | `4` | concurrent provider work |
| `search.default_response_tokens` | `4000` | default response budget |
| `search.max_response_tokens` | `16000` | maximum response budget |
| `search.threshold` | `0.5` | score threshold for selection |
| `source.max_file_bytes` | `1048576` | per-file eligibility limit |
| `source.follow_links` | `false` | `true` is rejected |
| `cache.ttl_seconds` | `604800` | seven days for pinned models |
| `cache.max_bytes` | `104857600` | 100 MiB cache limit |
| `cache.rolling_ttl_seconds` | `900` when omitted | at most 15 minutes for known rolling aliases |

Response budgets use the bundled reference tokenizer, not the calling agent's tokenizer.
An enabled USD cap requires a matching dated provider rate card in the configuration.
Inspect the configuration examples before setting a cost cap.

Set `cache.rolling_ttl_seconds` to `0` to disable rolling reuse, or
`cache.enabled` to `false` to disable all score reuse. `doctor` reports the active
policy. Scores from a rolling alias can be stale within its reuse window.

Requests pack fragments by the full serialized token estimate, with provider-specific
headroom and local question/byte limits. See [request batching](../README.md#request-batching).

Optional `search.retry` settings default to two retries, a 250 ms base delay and a
5,000 ms maximum jittered delay. `Retry-After` applies across workers. Ambiguous
attempts are not retried unless `retry_ambiguous` is enabled; repeated attempts can
incur additional charges.

## Search

These single-line commands work in PowerShell and POSIX shells:

```bash
jevgrep search --query "Which handler invalidates cached user data?" --scope src --json
jevgrep search --query-file question.txt --max-context-tokens 4000
jevgrep search --config "/absolute/path/to/config.json" --query "How are permissions checked?"
```

The question file is read verbatim. Scope can narrow authorization, never expand it.
Add `--allow-partial` to permit a deterministic partial scan when an enabled cap
would otherwise reject the search.

Exit codes are `0` complete (including an empty selection), `2` invalid request,
configuration problem or preflight rejection, `3` partial, `4` fatal failure, and
`130` interrupted. Results go to stdout and diagnostics to stderr.
Read coverage and stop reasons before interpreting an empty or partial result.

## Connect an MCP client

Set up the provider and repository first. Start the server with an explicit profile:

```bash
jevgrep mcp --config "/absolute/path/to/config.json"
```

It exposes one tool, `semantic_search_code`, and exits when stdin closes. Startup
does not scan or contact a provider. A tool call uses the same engine and authorization
as CLI search. Each process serves one repository; use separate server names/profiles
if configuring several repositories.

See the [README MCP examples](../README.md#use-through-mcp) for Claude Code, Codex and
clients using JSON configuration. The examples follow the
[Codex](https://developers.openai.com/codex/mcp) and
[Claude Code](https://code.claude.com/docs/en/mcp) documentation.

For Windows clients that cannot launch the npm command shim, use `node.exe` directly.
Replace all three paths with your installation and profile paths:

```json
{
  "mcpServers": {
    "jevgrep": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/tools/jevgrep/dist/cli.js",
        "mcp",
        "--config",
        "C:/Users/me/path/to/config.json"
      ]
    }
  }
}
```

For a linked checkout, the CLI path is `dist/cli.js` inside that checkout.
Keep the checkout available while the client uses it. No credential needs to appear
in this JSON when the client runs as the same user who completed global setup.
If using environment credentials, ensure the client process receives them.

The internal search deadline defaults to **300 seconds**. A client timeout of
**360 seconds** is a starting point to test, not a measured guarantee. Adjust the
client timeout when changing `search.deadline_ms`. Check the client's output limits
against the configured response budget as well.

Real Codex and Claude Code interoperability remains unqualified. Verify that the
client lists the tool, completes a search and shows the result without truncation.

## Maintenance

```bash
jevgrep cache clear
```

Use `--config` to target an explicit profile. Cache clearing does not edit source files.
Search reads the repository; initialization can create `.jevgrepignore`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `jevgrep` command not found | run `npm link`, check the npm global bin is on PATH, or launch `node /path/to/dist/cli.js` |
| Invalid or missing profile | run `jevgrep init` in the target repository, or pass an absolute `--config` path |
| Configuration is inside its authorized root | move the profile outside that repository |
| `REMOTE_DISABLED` | inspect the scope, then enable remote evaluation in the trusted profile |
| `CREDENTIAL_MISSING` | run global setup or provide the selected provider's environment key to the process |
| `RESPONSE_BUDGET_TOO_SMALL` | increase `--max-context-tokens` within the configured maximum |
| `SCOPE_EXCEEDS_SCAN_BUDGET` | narrow the scope, adjust the enabled cap, or use `--allow-partial` |
| `PROVIDER_AUTH` | check the selected provider, credential and model access |
| `PROVIDER_RATE_LIMIT` | retry later or reduce `search.concurrency` |
| Changed files omitted from results | rerun the search against the current files |
| `no_score_above_threshold` | rephrase or widen the scope; this does not prove absence |
| MCP timeout | align the client timeout with the internal search deadline |
| MCP cannot launch on Windows | use absolute paths to `node.exe` and `dist/cli.js` as above |

## Validation status

The local verification gate covers type checking, offline tests, packaging into a clean
temporary installation, build and smoke checks. CI is configured for Ubuntu and Windows;
its current results are available in [GitHub Actions](https://github.com/nassim-arifette/jevgrep/actions).

TypeSafe direct has simulated-response coverage but no recorded live account test.
Vercel has been checked on a small live authentication example, including cache reuse.
Neither those checks nor the offline suite establishes retrieval quality on arbitrary
repositories. Real MCP clients still need qualification.
