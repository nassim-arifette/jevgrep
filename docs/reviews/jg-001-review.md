# JG-001 — Independent review (M, adversarial)

**Issue:** [JG-001 — Initialiser le package TypeScript et les contrôles hors ligne](issues.md#jg-001).
**Contracts checked:** specification §4.5 (CLI surface and exit codes) and §11.1 (deterministic contract tests);
implementation plan §3 (P1 scaffold) and §10 (repository layout).
**Reviewer role:** M reviews J's work against the contracts and with adversarial cases
(workflow §6 step 4).

**Reviewed revision:** commit `03d27018ccceec13bf01734a105737b3426b0056`
("feat(jg-001): initialize the TypeScript package and its offline controls"), the HEAD of the shared
working tree when the review started. The tree was copied to `/mnt/c/tmp/jg001-review` (Windows side)
and `/tmp/jg001-linux` (Linux side) **before** any other agent wrote to the shared tree, so all
verdicts below apply to that revision only.

**Runtimes used:** Windows — `C:\nvm4w\nodejs\node.exe` v24.15.0 with npm 11.12.1 (driven from WSL,
i.e. the same binaries a Windows contributor uses); Linux — official
`node-v24.15.0-linux-x64.tar.xz` unpacked in `/tmp/node24`, npm 11.12.1.
Both match `.nvmrc` (`24.15.0`, "Krypton" LTS per `https://nodejs.org/dist/index.json`).

**Nothing was fixed and nothing was committed.** The only file written in the repository is this review.
Everything else happened in the two scratch copies above.

## 1. Revision identity

| File | sha256 of the reviewed revision |
| --- | --- |
| `src/cli.ts` | `2807fc0f1f930a03a02613c3e88aaf7ceead492f560b6c65a1b916ec8d5f16b2` |
| `tsconfig.json` | `e09847e7d51091c75fea6788d57680b1f2f924ca9e60e9a1a8288cd7fe72b5fb` |
| `tsconfig.build.json` | `c0a55cd5aba51e0b74efb55f53d86067941bee779f81c6d0cc7896fb78ead8b7` |
| `package.json` | `e65bc8f60d2af6817b90fad2664ea6417178da28401c9340c58e48c43b660388` |
| `package-lock.json` | `d2cacb40f883b933b8c19e1aec04206151f5fbdd4790c58472315c6a6337b02c` |
| `tests/offline-guard.test.ts` | `84853b6243743d6498ac7ee5afda642335e2a41647955c4d87d8d3da85027d5d` |
| `tests/type-check-gate.test.ts` | `7524dd1af3e08e5adb4c707e0ff2259029f760919c1e782410331c297eaa3e52` |
| `.nvmrc` | `b911698dc3cf3227d34d0ad6727f1c4408791203c9665de99ab959331a1fb07d` |
| `.github/workflows/ci.yml` | `d297a9f63a779209c22ac98dc494057588df3c0adc1e73d610ff0d7fe5bac7c6` |
| `README.md` | `bba01b532044f9993214b26cb59aa5b8e7f836c56a2bd76ca67070542f536c72` |
| `scripts/smoke.ts` | `166fd1715d399112d1ab5e0c89ec1c827cc531525853832cf09874c35e62a341` |
| `tests/cli.test.ts` / `tests/cli-entry.test.ts` / `tests/project-config.test.ts` / `tests/helpers/cli-runner.ts` | `ecf1365f…2057` / `a4f279a3…1da9` / `0b3e4a79…9d14f` / `16ba3df1…7751` |
| `.gitignore` / `.gitattributes` / `.editorconfig` | `d4ba5391…142a` / `061e18ac…655f` / `a6b98ea7…fdcd` |

`git show HEAD:tsconfig.json | sha256sum` returns the same `e09847e7…` value, so the copy is byte-identical
to the committed revision. `git remote -v` prints nothing: **the repository has no remote, so the CI
workflow has never run.**

The shared tree moved while the review was being written. At the end of the review, `HEAD` was
`d33a28e` ("feat(jg-027): start the retrieval corpus with the orders-api fixture"), which adds
`benchmarks/**` and a `corpus:check` script to `package.json`, and the working tree carried more
uncommitted work by other agents: `README.md` status paragraph rewritten,
`tsconfig.json` extended with `benchmarks/tools/**/*.ts` in `include` and
`exclude: ["tests/fixtures/**"]`, plus untracked `src/testing/`, `tests/fixtures/`,
`tests/scripted-provider.test.ts` and `tests/fixture-repositories.test.ts`.
None of that is part of the revision reviewed here, and no verdict below depends on it. Only two
reviewed files changed content after the copy was taken: `package.json` (`e65bc8f6…` → `4807ee0a…`,
the new `corpus:check` script) and `README.md` (`bba01b53…` → `8ac7440d…`, see D2). All other hashes in
the table above still match the tree (`src/cli.ts`, `package-lock.json`, `tsconfig.build.json`,
`.nvmrc`, `.github/workflows/ci.yml`, `tests/offline-guard.test.ts`, `tests/type-check-gate.test.ts`,
`scripts/smoke.ts` were re-checked and are unchanged).

## 2. Verdict per acceptance criterion

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Install from the lockfile + compile succeeds on Windows and Linux | **PASS** |
| 2 | A type error fails the type check with a non-zero exit code | **PASS** |
| 3 | The usual tests need no Jev key and make no provider network call | **PASS** |
| 4 | The package has an executable entry point; no unimplemented command is presented as available | **PASS** |
| 5 | Runtime versions and development commands are documented | **PASS** (one documentation defect, already fixed in the tree) |

### Criterion 1 — PASS

Windows (lockfile install with the Windows npm, then compile):

```console
$ cd /mnt/c/tmp/jg001-review && npm ci --no-audit --no-fund
added 4 packages in 5s                     # exit 0
$ npm run build                            # tsc -p tsconfig.build.json -> exit 0, dist/cli.js + dist/cli.js.map
```

Linux (official Node tarball, Linux npm, case-sensitive file system):

```console
$ rsync -a --exclude node_modules --exclude dist /mnt/c/tmp/jg001-review/ /tmp/jg001-linux/
$ cd /tmp/jg001-linux && export PATH=/tmp/node24/bin:$PATH && npm ci --no-audit --no-fund
added 4 packages in 1s                     # exit 0  (node_modules/@typescript/typescript-linux-x64)
$ npm run verify                           # exit 0
ℹ tests 23   ℹ pass 23   ℹ fail 0
smoke: all 7 checks passed
```

The lockfile is `lockfileVersion: 3`, every entry has an `integrity` hash, the two dependencies are
exactly pinned (`@types/node 24.13.6`, `typescript 7.0.2`) and the TypeScript 7 native compiler ships
one platform package per OS/CPU with `os`/`cpu` constraints, so the Windows run installs
`@typescript/typescript-win32-x64` and the Linux run installs `@typescript/typescript-linux-x64` from
the same lockfile. Windows installs 4 packages, Linux installs 4 packages, no platform package is missing.

**Limits of this proof.** "Both platforms" was reproduced locally on both platforms, not in GitHub
Actions: the repository has no remote, so `ci.yml` has never executed. See Nit N4.

### Criterion 2 — PASS

`npm run typecheck` propagates the compiler exit code (1), and `npm run build` exits 2 on the same
error. I wrote five deliberate, independent errors — none of them the one used by the test suite —
into `src/`, `tests/` and `scripts/` in the copy:

| Probe (own file, own error) | Observed |
| --- | --- |
| `export function f(n: number): string { return n; }` | `error TS2322: Type 'number' is not assignable to type 'string'.` — `npm run typecheck` exit **1** |
| `const parsed: unknown = JSON.parse('{"a": 1}'); const value: { a: string } = parsed;` | `error TS2322: Type 'unknown' is not assignable…` — exit **1** |
| wrong-arity / mistyped callback `list.forEach((item, index: string) => …)` | `error TS2345: … Type 'number' is not assignable to type 'string'.` — exit **1** |
| unhandled null via `noUncheckedIndexedAccess`: `const first: string = scopes[0];` (in `tests/`) | `error TS2322: Type 'string | undefined' is not assignable…` — exit **1** |
| `exactOptionalPropertyTypes`: `const options: Options = { query: undefined };` (in `scripts/`) | `error TS2375: … with 'exactOptionalPropertyTypes: true'` — exit **1** |
| missing return path with `noImplicitReturns` | `error TS2366: Function lacks ending return statement…` — exit **1** |

All probes were deleted afterwards; `src/`, `tests/` and `scripts/` are back to their original content.
One unrelated crash path exists for `--version` in a corrupt install; it is reported as defect D3.

`include` covers `src`, `tests` and `scripts`, so a broken test file fails the check too (probe 4 above).
The suite's own gate test (`tests/type-check-gate.test.ts`) writes `export const wrong: string = 1;`
into `src/__type_check_gate__.ts`, runs the pinned compiler, and asserts a non-zero code plus
`__type_check_gate__` and `error TS\d+` in its output — I confirmed both tests pass on both platforms
(Windows: 1 208 ms / 808 ms; Linux: 290 ms / 283 ms).

### Criterion 3 — PASS

Two independent proofs, both with the full `npm run verify` (23 tests + build + 7 smoke checks):

```console
# 1. no credential-looking variable exists at all in the environment
$ cd /tmp/jg001-linux && env -i PATH=/tmp/node24/bin:/usr/bin:/bin HOME=/tmp npm run verify
ℹ pass 23   ℹ fail 0
smoke: all 7 checks passed                 # exit 0

# 2. no network at all: isolated network namespace (control call got ENETUNREACH)
$ cd /tmp/jg001-netns && unshare -rn env PATH=… HOME=/tmp npm run verify
ℹ pass 23   ℹ fail 0
smoke: all 7 checks passed                 # exit 0
```

The offline guard is not vacuous. I mutated `src/cli.ts` in a copy by inserting a real network call at
the top of `main()` and re-ran `node --test tests/offline-guard.test.ts` for four different transports:

| Injected call | Guard result |
| --- | --- |
| `await fetch('https://example.invalid/')` | FAIL — "offline guard blocked a fetch call" (exit 1) |
| `net.connect(80, '127.0.0.1')` | FAIL — blocked a `net.Socket#connect` call (exit 1) |
| `https.request('https://example.invalid/').end()` | FAIL — blocked a `net.Socket#connect` call (exit 1) |
| `await dns.promises.lookup('example.invalid')` | FAIL — blocked a `dns.promises.lookup` call (exit 1) |

Static check: `src/cli.ts` imports only `node:fs`, `node:process` and `node:url`; no other file under
`src/` or `scripts/` imports a network module; the only occurrences of `JEV|API_KEY|TYPESAFE|ACCESS_TOKEN`
are the removal patterns in `tests/helpers/cli-runner.ts` and the comment in `tests/cli-entry.test.ts`.
The test files are separate processes under `node --test`, so the guard's patches cannot leak.

### Criterion 4 — PASS

Entry point:

```console
$ npm pack --dry-run
npm notice 5.8kB dist/cli.js   npm notice 3.7kB dist/cli.js.map
npm notice 761B package.json   npm notice 3.7kB README.md      # total files: 4
$ cd /tmp/jg001-linux && npm link && ls -l $(which jevgrep)
/tmp/node24/bin/jevgrep -> ../lib/node_modules/jevgrep/dist/cli.js   # mode 0755
$ cd /tmp && jevgrep --version        # jevgrep 0.0.0      (exit 0)
$ jevgrep search --query x            # exit 69
$ jevgrep                             # exit 2
```

`bin` is `{"jevgrep": "./dist/cli.js"}`, `files` is `["dist"]`, the emitted file keeps its
`#!/usr/bin/env node` shebang (also asserted by `scripts/smoke.ts`), and `--version` works from an
unrelated directory because the manifest is resolved from the module URL, not from `process.cwd()`.

Exit-code and honesty matrix of the built CLI (Windows node, cwd = copy, stdout and stderr separated):

| Invocation | Exit | stdout | stderr |
| --- | --- | --- | --- |
| *(no argument)* | 2 | empty | `jevgrep: no command given` + usage hint |
| `--help`, `-h` | 0 | full help | empty |
| `--version`, `-V` | 0 | `jevgrep 0.0.0` | empty |
| `--help extra` | 2 | empty | `unexpected argument 'extra' after '--help'` |
| `--version --json` | 2 | empty | `unexpected argument '--json' after '--version'` |
| `--verbose`, `--` | 2 | empty | `unknown option '--verbose'` / `'--'` |
| *empty string*, `help`, `SEARCH`, `frobnicate` | 2 | empty | `unknown command '…'` |
| `search …`, `inspect …`, `doctor …`, `mcp …`, `cache …`, `cache clear …` | 69 | empty | `jevgrep: '<cmd>' is planned (JG-0xx) but not implemented in this build; no work was performed` |

No unimplemented command is presented as available: `--help` prints the available options first
(`-h, --help`, `-V, --version`) and lists `search`, `inspect`, `doctor`, `mcp`, `cache` only **after**
the line "planned commands, not implemented in this build (each one exits 69 and performs no work)";
the README repeats it. The help's exit-code list marks 3, 4 and 130 as "not implemented in this build"
and 69 as "command planned but not implemented in this build" — consistent with specification §4.5
(0 complete, 2 invalid, 3 partial, 4 fatal, 130 interruption), which keeps 69 outside the reserved set.

### Criterion 5 — PASS

`README.md` states the runtime ("Node.js 24.15.0 LTS, pinned in `.nvmrc`; `package.json` accepts
`>=24.0.0 <25.0.0`") and documents `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run smoke` and `npm run verify`. Every one of those commands was executed successfully on both
platforms (criterion 1), and the two other documented entry points work:

```console
$ node src/cli.ts --help        # source run, Windows and Linux: exit 0
$ npm link && jevgrep --version # documented "npm link exposes it locally": exit 0, "jevgrep 0.0.0"
```

The three version declarations agree: `.nvmrc` = `24.15.0` (Krypton LTS, confirmed against
`https://nodejs.org/dist/index.json`), `engines.node` = `>=24.0.0 <25.0.0`, CI installs from
`node-version-file: .nvmrc`. `npm test` fails with a clear message if the suite runs on another Node
major (`tests/project-config.test.ts`), which keeps the documented runtime honest.

CI (`.github/workflows/ci.yml`): valid YAML (parsed with PyYAML), `ubuntu-latest` + `windows-latest`,
`actions/checkout@v7` and `actions/setup-node@v7` both exist as tags on GitHub (checked through the
GitHub API), `cache: npm`, then `npm ci` and `npm run verify`. `npm ci` + `npm run verify` is exactly
what I reproduced locally on both platforms, and `npm run verify` runs `test` before `build`, so the
smoke step always has a `dist/` to run.

## 3. Defects

### D1 — a killed test run leaves a deliberate type error inside `src/` (severity: **medium**, non-blocking)

* **File:** `tests/type-check-gate.test.ts` (line ~21: `const gateFile = join(repoRoot, 'src', '__type_check_gate__.ts')`), with `.gitignore` line 7.
* **Reproduction (executed):** start `node --test tests/type-check-gate.test.ts` in a copy, wait until
  `src/__type_check_gate__.ts` exists, then `kill -9` the process (this is what an interrupted or
  out-of-memory run does):

```console
$ node --test tests/type-check-gate.test.ts &   # killed with SIGKILL while the gate file existed
$ cat src/__type_check_gate__.ts
export const wrong: string = 1;
$ npm run typecheck     # exit 1: src/__type_check_gate__.ts(1,14): error TS2322 …
$ npm run build         # exit 2: same error, the file is inside tsconfig.build.json's include
$ npm test              # 22 pass, 1 fail: "the untouched project passes its own type check"
$ git check-ignore -v src/__type_check_gate__.ts
.gitignore:7:src/__type_check_gate__.ts	src/__type_check_gate__.ts   # invisible to git status
```

* **Expected:** a type-check gate must not leave a poisoned artifact in the source directory, or must
  make the leftover self-identifying. **Observed:** the file survives an abrupt kill, is invisible to
  `git status`, and silently breaks `typecheck`, `build` and one test until someone deletes a file they
  never created. The `finally`/`after` hooks only run on a graceful exit.
* **Suggested fix (author's choice):** create the gate project in a temporary directory (a tiny
  `tsconfig` that `extends` the real one and includes `../src`), or write the broken file only under a
  path excluded from `tsconfig.build.json` and documented in the README's troubleshooting line.
  A name such as `src/__type_check_gate__.ts` plus the `.gitignore` entry is already half the
  mitigation; the missing half is that nothing tells the developer where the error comes from.

### D2 — stale "Project status" paragraph contradicted the delivered CLI (severity: **low**, already fixed in the tree)

* **File:** `README.md` line 5 of the reviewed revision:
  "**Project status:** specification and implementation plan. No CLI, server, or application code exists yet."
* **Reproduction:** read `README.md` at revision `bba01b53…`; the same file's new `## Development`
  section documents `node src/cli.ts --help`, `dist/cli.js` and `npm link`, and `bin` already exposes
  `jevgrep`.
* **Expected:** one status statement consistent with the delivered scaffold. **Observed:** the
  paragraph is a leftover of the documentation commit (`docs: JevGrep specification…`, not this
  commit) that JG-001's README change made false.
* **Status:** the working tree already corrects it (`README.md` sha256 `8ac7440d…`, new text
  "implementation has started. The TypeScript/CLI scaffold and the first offline test infrastructure
  exist, but …"). No further action needed beyond committing that edit.

### D3 — `--version` exits 1 with an unhandled stack trace when the manifest is unreadable (severity: **low**, non-blocking)

* **File:** `src/cli.ts` → `readPackageVersion()` (`JSON.parse(readFileSync(...))`), used by the `-V/--version` branch.
* **Reproduction (executed):** copy only the built entry point into a directory with no manifest:

```console
$ mkdir -p /tmp/brokenpkg/dist && cp dist/cli.js /tmp/brokenpkg/dist/ && cd /tmp/brokenpkg
$ node dist/cli.js --version
Error: ENOENT: no such file or directory, open '/tmp/brokenpkg/package.json'
    at readPackageVersion (file:///tmp/brokenpkg/dist/cli.js:83:33) …
$ echo $?
1
```

* **Expected:** the documented exit-code surface (0, 2, 3, 4, 130 in specification §4.5, plus the
  scaffold's 69), and no raw stack trace or absolute path on stderr. **Observed:** exit 1, an
  undocumented code, and a Node stack trace; the same happens with a malformed `package.json`.
* **Reachability:** low — an installed package always ships its manifest, so this needs a corrupt
  install (`dist/` copied without `package.json`). A one-line `try/catch` returning code 4 (fatal
  runtime failure) or 2 would keep the documented contract exact.

## 4. Nits and improvements (all non-blocking)

* **N1 — the offline guard proves 3 of its 10 patches.** The sanity block checks `fetch`, `net.connect`
  and `Socket#connect`; `http.request/get`, `https.request/get`, `net.createConnection`,
  `dns.lookup`, `dns.promises.lookup` are installed but never proven to be armed. `patch()` also
  ignores the boolean returned by `Reflect.set`, so a future non-writable property would leave the
  guard silently unarmed while the test still passes. Asserting `Reflect.set(...) === true` and adding
  one probe per patched entry point would remove the residual "pass for the wrong reason" risk.
* **N2 — child processes are outside the guard.** `tests/offline-guard.test.ts` drives `cli.main()`
  in-process; the real entry point is exercised in child processes (`tests/cli-entry.test.ts`) where the
  patches cannot apply. My isolated-network-namespace run covers that path, but the suite itself does
  not. A `NODE_OPTIONS=--import ./tests/helpers/offline-preload.ts` on the spawned CLI would close it.
* **N3 — the gate test bypasses the npm script.** It spawns `node node_modules/typescript/bin/tsc`
  directly, so the suite never proves that `npm run typecheck` (the documented command) exits non-zero.
  I verified it manually (exit 1 for `typecheck`, 2 for `build`); one extra assertion on the script
  would make the acceptance criterion self-testing.
* **N4 — the CI workflow is unproven.** There is no git remote, so `ci.yml` has never run; the action
  majors are floating tags (`@v7`), and `npm ci` there has no `--no-audit --no-fund` (harmless). Also
  no `timeout-minutes`. Everything it runs was reproduced locally on both platforms, so the risk is
  low, but the claim "CI Windows/Linux" in `docs/issues.md` should stay "workflow added, not yet run"
  until the repository has a remote.
* **N5 — `npm run smoke` needs a prior build.** On a fresh clone it exits 1 with
  "dist/cli.js is missing; run 'npm run build' first" — honest, but the README table does not say the
  `dist/` prerequisite. One word in the table would remove the surprise.
* **N6 — future fixtures will collide with the type-check include.** `tsconfig.json` includes
  `tests/**/*.ts` and `npm test` globs `tests/**/*.test.ts`; the plan's layout (§10) puts synthetic
  repositories under `tests/fixtures/`. A deliberate malformed fixture (needed by JG-003/JG-011) will
  therefore enter the type check and, if it is named `*.test.ts`, the test run. The corpus workstream
  has already added `"exclude": ["tests/fixtures/**"]` to `tsconfig.json` in the working tree, which
  handles the type check; the test glob is still unguarded, so either keep fixture files away from the
  `*.test.ts` suffix or add an explicit exclusion (the `--test` glob cannot express `!` excludes, so
  `--test-skip-pattern` or a different suffix is the practical answer).
* **N7 — `dist/cli.js` is not executable in the build tree on Linux** (`0644` after `tsc`); `npm link`
  and `npm exec` set the bit, so the documented paths work, and `./dist/cli.js` directly after a bare
  `npm run build` fails with EACCES. Worth one line in the README, or a `chmod` step in the build.
* **N8 — `*.tsbuildinfo` is ignored although `incremental` is never enabled.** Harmless dead rule.
* **N9 — `.nvmrc` pins `24.15.0` while `engines` accepts any `24.x`** (latest LTS patch at review time:
  `24.21.0`). Consistent, but the suite only checks the major, so a contributor on `24.9.0` passes
  while CI runs `24.15.0`. Acceptable for a scaffold; say so in the README if it is intentional.

## 5. Test-suite assessment (adversarial pass)

Checked and found sound: no `.skip`, `.todo`, `.only` or `assert.ok(true)` anywhere under `tests/`;
the suite was run three times in a row on Linux (23/23 each time, `src/` left clean), so no flakiness
was observed; every test is a real assertion on exit codes, streams or emitted text — I found none that
can never fail. The `helpText()` comparison in `tests/cli.test.ts` compares the CLI output with the
function that produces it, but the spawned-process tests and `scripts/smoke.ts` assert the same text
independently, so the tautology is covered elsewhere. No path or line-ending assumption is visible: the
tests resolve the repository from `import.meta.url`, use `join()`/`URL`, and no checked-in file
contains CRLF (`grep -rlP '\r'` over `*.ts`, `*.json`, `*.yml`, `*.md` returns nothing), which matches
`.gitattributes` (`* text=auto eol=lf`) and `.editorconfig`.

Weaknesses worth tracking (details in D1, N1, N2, N3): the gate test writes into `src/` and only
cleans up on a graceful exit; the offline guard is armed for 10 entry points but only 3 are proven;
and the type-check gate tests the compiler directly rather than the documented npm script.

## 6. What I could not reproduce

1. **GitHub Actions execution** of `ci.yml` — no remote exists, so both matrix jobs are unrun. I
   verified instead: the YAML parses, the two action tags exist, and `npm ci` + `npm run verify`
   succeed on the same two operating systems locally.
2. **A real Windows shell (`cmd`/PowerShell) session.** I drove the Windows `node.exe`/`npm` from WSL
   with `cwd` inside the repository, which is what npm's own script runner (`cmd.exe`) then did for
   `npm run verify`; a native Windows terminal was not available on this host.
3. **The shared working tree at the exact moment of this review.** It moved while I worked (new commit
   `d33a28e` with `benchmarks/**` and a `corpus:check` script, README status fix, `src/testing/`,
   `tests/fixtures/`, `tests/scripted-provider.test.ts`, `tests/fixture-repositories.test.ts`). All
   verdicts apply to commit `03d2701` as copied; the three reviewed files whose hashes changed
   afterwards (`README.md`, `package.json`, `tsconfig.json`) are listed in §1 and reported where they
   matter (D2, N6).
