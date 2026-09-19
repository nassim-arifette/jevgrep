# JevGrep installation and configuration guide

For one operator, on one machine, authorizing one local repository. It covers a clean
Windows install, the same steps on Linux, connecting the stdio server to an MCP client
such as Codex, and the failures you are most likely to hit.

> **Status of this guide (2026-09-19).** The engine, the CLI command layer and the MCP
> server exist and are covered by the offline suite. This is a development guide;
> the operational commands below describe the future qualified installation.
> The executable still uses the scaffold (exit 69), live search is explicitly blocked
> in `src/readiness.ts`, and no real Codex interoperability run has been performed.
> See [the current handoff](handoff.md) before attempting activation.

## 1. What leaves your machine

Read this before enabling remote evaluation.

After qualification and activation, the intended behaviour when
`remote_evaluation_enabled` is `true` is to send **the text of eligible source
fragments** from the authorized repository, together with your search question, the
relative path and line range of each fragment, and the versioned relevance criterion, to
the configured provider endpoint (`https://api.typesafe.ai`). "Local" in this project
describes the JevGrep process, not the evaluation: the evaluation is remote.

The exclusion policy in §5.2 of the specification covers
`.git`, the `.env` family, package-manager credential files, key material, dependencies,
build output, generated and minified artifacts, oversized files, and any file in which a
credential pattern is detected (the whole file is quarantined for that search, not
rewritten). Source authorization and Windows reparse-point handling still require
senior qualification (JG-008); the draft is not a proven confinement boundary.
The provider credential is read from an environment variable and is sent
only in the `Authorization` header of the provider request; redirects are refused rather
than followed.

What this guide does not promise: zero retention by the provider, or any inference
running on your machine. The provider's terms are the provider's; see
[research/jev.md](research/jev.md).

Run `jevgrep inspect` before your first real search: it lists exactly what would be
prepared, and it contacts nobody.

## 2. Requirements

| Component | Version used for this guide |
| --- | --- |
| Node.js | 24.15.0 (pinned in [`.nvmrc`](../.nvmrc); `package.json` requires `>=24.0.0 <25.0.0`) |
| npm | 11.12.1 |
| OS verified for the consolidated implementation | Windows 11 (26200); Linux remains to be run; CI is configured but has not executed |
| Runtime dependencies | one: `tiktoken@1.0.22`, whose `cl100k_base` vocabulary ships in the package and is never fetched at run time |
| Jev provider | account with access to the configured model (`jev-1.13.0` at the time of writing) |

## 3. Install the versioned artifact

From a clean checkout of the repository, on Windows PowerShell or a POSIX shell:

```bash
npm ci            # installs exactly the lockfile, no version drift
npm run verify    # type check, offline test suite, build, smoke checks
npm run build     # produces dist/cli.js, the executable entry point
```

`npm ci` installs the pinned versions from `package-lock.json`, so no step of this guide
fetches a floating version at start-up. To use the command as `jevgrep` rather than
`node dist/cli.js`:

```bash
npm link          # or: npm pack, then npm install -g ./jevgrep-<version>.tgz
jevgrep --version
```

Record the exact artifact you installed (`npm pack` output or the commit hash). Keep it:
the MCP configuration below points at an absolute path inside it.

## 4. Create the trusted configuration

The configuration file must live **outside** the repository it authorizes — a file the
searched repository could edit cannot grant authorization, and JevGrep refuses to load
one from inside the root it would authorize.

Copy [`docs/examples/jevgrep.config.json`](examples/jevgrep.config.json) to, for example,
`C:\Users\<you>\.jevgrep\orders-api.json`, then set:

- `repository_root`: absolute path of the repository, with forward slashes
  (`C:/work/orders-api` or `/home/you/work/orders-api`);
- `remote_evaluation_enabled`: leave `false` until you have read §1. `doctor` and
  `inspect` work with it disabled; `search` refuses with `REMOTE_DISABLED`;
- `provider.api_key_env`: the environment variable that holds your credential. The
  credential itself is never written in this file;
- `provider.model`: the model your account can use.

Everything else can stay as shipped. Notable defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `scan_caps.*` | `null` | every optional spend/volume cap is **disabled**; `null` means off, `0` does not mean unlimited |
| `search.deadline_ms` | `60000` | internal deadline, including preparation and queue wait |
| `search.default_response_tokens` / `max_response_tokens` | `4000` / `16000` | response budget under the pinned `tiktoken@1.0.22/cl100k_base` counter |
| `search.threshold` | `0.5` | provisional selection threshold, to be chosen on development data (JG-028) |
| `source.max_file_bytes` | `1048576` | per-file eligibility limit |
| `source.follow_links` | `false` | links and junctions are never followed; `true` is rejected |
| `cache.*` | enabled, 7 days, 100 MiB | evaluation cache, stored per user outside the repository |

Set the credential in your shell profile, never in the configuration file:

```powershell
# Windows PowerShell
$env:TYPESAFE_API_KEY = "<your key>"
```

```bash
# POSIX shell
export TYPESAFE_API_KEY="<your key>"
```

Optional: `JEVGREP_CACHE_HOME` moves the cache directory. By default it is
`%LOCALAPPDATA%\jevgrep` on Windows and `$XDG_CACHE_HOME/jevgrep` (or `~/.cache/jevgrep`)
elsewhere, namespaced by repository and configuration fingerprint.

## 5. Check the setup without sending anything

```bash
jevgrep doctor  --config C:/Users/<you>/.jevgrep/orders-api.json
jevgrep inspect --config C:/Users/<you>/.jevgrep/orders-api.json --scope src --scope tests
```

`doctor` prints the authorized root, the provider destination and model, whether remote
evaluation is enabled, whether the credential variable is set (never its value), the
response counter, the active and disabled caps, the source rules and the cache location.
`inspect` prints the eligible files, the exclusions with their reasons, the prepared
fragment count and size, and an estimate of the first-attempt scan. Neither contacts the
provider; neither needs a credential.

> **Pending (JG-023).** Until `src/cli.ts` dispatches to `src/cli-commands.ts`, these two
> commands exit `69` from the scaffold. The behaviour above is the one covered by
> `tests/cli-commands.test.ts`.

## 6. Run a search

```bash
jevgrep search --config C:/Users/<you>/.jevgrep/orders-api.json \
  --query "Which handler invalidates cached user data on a subscription change?" \
  --scope src --max-context-tokens 4000 --json
```

Use `--query-file question.txt` for a multiline question: the file's content is the
question, verbatim, and is never interpreted as a shell command. Add `--allow-partial` to
let a scope that exceeds an **enabled** cap run as a deterministic partial scan instead of
being refused.

Exit codes: `0` complete (including an empty selection), `2` invalid request,
configuration problem or preflight rejection, `3` partial result, `4` fatal failure,
`130` interrupted. stdout carries the result; stderr carries diagnostics, so a pipeline
keeps the evidence even when the code is non-zero.

## 7. Connect an MCP client

Start the server manually once:

```bash
jevgrep mcp --config C:/Users/<you>/.jevgrep/orders-api.json
```

It starts without scanning the repository and without contacting the provider, exposes
one tool (`semantic_search_code`), and exits when stdin closes.

Configure your MCP client with **absolute paths** — the working directory of a client is
not something to rely on. The shape below is the common stdio-server form; the exact file
and syntax depend on your client's version, so check its documentation:

```json
{
  "mcpServers": {
    "jevgrep": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\tools\\jevgrep\\dist\\cli.js",
        "mcp",
        "--config",
        "C:\\Users\\<you>\\.jevgrep\\orders-api.json"
      ],
      "env": { "TYPESAFE_API_KEY": "<set this in the client's own secret store>" }
    }
  }
}
```

Two client settings matter:

- **Tool timeout.** The internal deadline defaults to 60 s. A **75 s** client timeout
  is a proposal to measure, not a guarantee: bounded provider cleanup and completion
  still need qualification. Adjust the client timeout when changing the internal one.
- **Output limit.** One call returns one JSON payload bounded in reference tokens.
  Reference tokens do not establish a client byte limit. Measure the largest payload
  with the actual client and record its timeout, truncation and byte behaviour.

> **Not verified here ([JG-006 transport report](reports/jg-006-mcp-interoperability.md), JG-026).** The actual Codex connection has not been tested.
> Request the largest response your qualified configuration allows and
> confirm the client shows it whole, with no truncation notice.

## 8. Maintenance

```bash
jevgrep cache clear --config C:/Users/<you>/.jevgrep/orders-api.json
```

This removes only the cache belonging to that configuration. Nothing in JevGrep writes to
the searched repository.

## 9. Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `INVALID_CONFIG: … must live outside the repository it authorizes` | the configuration file is inside the authorized root | move it, for example to `~/.jevgrep/` |
| `INVALID_CONFIG: … expected an absolute POSIX or Windows drive path` | `repository_root` is relative | use an absolute path with forward slashes |
| `REMOTE_DISABLED` | remote evaluation is off | set `"remote_evaluation_enabled": true` after reading §1 |
| `CREDENTIAL_MISSING` | the variable named by `api_key_env` is unset or blank | export it in the shell (or the client's secret store) that starts JevGrep |
| `RESPONSE_BUDGET_TOO_SMALL` | the mandatory report does not fit the requested budget | raise `--max-context-tokens` (minimum 1 024, and the report envelope needs more) |
| `SCOPE_EXCEEDS_SCAN_BUDGET` | an **enabled** cap cannot hold the planned scan | narrow `--scope`, raise that cap, or pass `--allow-partial` |
| `PROVIDER_AUTH` | credential rejected, or the model is not available to the account | check the key and the model name with `doctor` |
| `PROVIDER_RATE_LIMIT` | the provider rate-limited the attempt | retry later; lower `search.concurrency` |
| `SOURCE_CHANGED` in `stop_reasons` | files changed while the search ran | expected in an active working tree; the stale excerpts are omitted, not returned with an old score |
| empty selection, `no_score_above_threshold` | nothing reached the threshold | rephrase the question, widen the scope, or lower `search.threshold` — and note the result does not prove the behaviour is absent |
| exit `69` | the command is parsed but not wired yet | see the status note at the top of this guide |

## 10. Tested matrix

| Item | Value | Evidence |
| --- | --- | --- |
| Node.js | 24.15.0, Windows 11 | `npm run verify` on this machine |
| Linux | consolidated artifact **not tested** | CI configured; no remote/run |
| Offline suite | 300+ tests, no key, no network | `npm test` |
| Response counter | `tiktoken@1.0.22/cl100k_base` | [reports/jg-006 counter](reports/jg-006-response-counter.md) |
| Provider SDK | `@typesafe-ai/sdk@0.6.0` pinned in the separate experiment; production choice pending | [reports/jg-004](reports/jg-004-offline-sdk.md) |
| MCP protocol | `2025-06-18`, `2025-03-26`, `2024-11-05` | [reports/jg-006 transport](reports/jg-006-mcp-interoperability.md), `tests/mcp-server.test.ts` |
| Codex | **untested** | no real-client qualification run |
| Live provider call | **never executed** | JG-004 and JG-005 remain open |
