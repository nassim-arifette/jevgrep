# JevGrep language search specification

Status: draft for review, 2026-11-24. Baseline: `main` at `09b0669` (v0.3.0).

## 1. Purpose

JevGrep's answer quality depends on what a fragment is before Jev ever scores it:
where it starts and ends, what its `Structure:` label says, and which fragments a
budgeted scan reaches first. Today that preparation is good for JS/TS, partial for
Python, Java, Go and Rust, and absent for every other language. This document
specifies the target behaviour per language, the shared machinery, and the gates a
change must pass before it ships.

Out of scope: the relevance criterion, request layout, selection and budgets.
Nothing here imports, compiles, executes or type-checks repository code.

## 2. Current state

### 2.1 What runs today

| Language | Extensions | Parser | Planner | Error handling |
|---|---|---|---|---|
| JS/TS | `.js .jsx .ts .tsx .mjs .cjs .mts .cts` | TypeScript compiler 6.0.2 | Recursive (depth cap 400), tiny-merge, header carry (`javascript-chunker.ts`) | Local: damaged statements become windows, rest keeps structure |
| Python | `.py .pyi` | Hand lexical scanner | Depth-indexed packing, 3 levels (`chunkWithBoundaries`) | One error: whole file to line windows |
| Java | `.java` | Hand lexical scanner | Same, 3 levels | Same |
| Go | `.go` | Tree-sitter 0.25.0 (WASM) | Same, 3 levels | Same (`root.hasError`) |
| Rust | `.rs` | Tree-sitter 0.24.0 (WASM) | Same, 3 levels | Same |
| Everything else | any | none | 80-line windows, 8-line overlap | n/a |

Language is chosen by file extension only.

### 2.2 Measured baseline

Offline run of the production chunker with default limits on 14 public repositories
(section 9.1 lists them), about 10,600 files. No provider call, so these are structural
facts, not retrieval scores. The mid-block and hidden-declaration columns are
indentation and label heuristics, good for comparing languages and versions, not
exact counts. Shell, SQL, TOML and Vue had under 130 files each and are left out of the tables.

Languages with a syntax chunker:

| Language | Files | Fragments | Labelled | Start mid-block | Declarations hidden | Split callables | Continuations unlabelled |
|---|---:|---:|---:|---:|---:|---:|---:|
| TS | 499 | 2,298 | 90.1% | 13.6% | 71.8% | 45 | 35.8% |
| JS | 244 | 800 | 75.6% | 14.5% | 73.8% | 8 | 50.0% |
| Python | 2,394 | 8,713 | 87.0% | 1.2% | 82.8% | 102 | 84.5% |
| Java | 348 | 1,024 | 74.9% | 13.9% | 79.2% | 5 | 100% |
| Go | 431 | 2,187 | 76.7% | 10.3% | 63.1% | 116 | 99.7% |
| Rust | 367 | 1,079 | 78.4% | 7.0% | 80.7% | 12 | 100% |

Languages on line windows (no label is ever produced):

| Language | Files | Fragments | Start mid-block |
|---|---:|---:|---:|
| C | 320 | 4,996 | 58.6% |
| C++ | 49 | 292 | 43.2% |
| PHP | 3,192 | 10,144 | 52.9% |
| Kotlin | 315 | 965 | 47.7% |
| Swift | 103 | 816 | 54.8% |
| Ruby | 161 | 471 | 44.4% |
| HTML | 753 | 6,541 | 66.4% |
| CSS/SCSS | 66 | 428 | 38.8% |
| YAML | 192 | 470 | 40.6% |
| JSON | 651 | 927 | 25.1% |
| Markdown | 292 | 1,951 | 17.2% |

Column definitions:

- **Start mid-block**: the fragment's first non-blank line is indented deeper than its
  least-indented line, so it opens inside a block that closes later in the same fragment.
- **Declarations hidden**: a function, method, class, struct, enum, trait, impl,
  interface, type, record or mod whose fragment is labelled with a different symbol
  (several declarations were packed together and only the first is named).
- **Split callables**: functions or methods spread over more than one fragment.
- **Continuations unlabelled**: fragments of a split callable after the first one that
  carry no label.

Packing several small declarations into one fragment is intended, so a high
hidden share is not a defect by itself. It shows how many symbol names the label
never exposes to the lexical priority (LS-6).

Parse fallback is not the problem on well-formed code: 10 of 4,283 files fell back
or were partly recovered, eight ANSI-coloured fixtures of `bat` and two
Django-templated `.js` files. It becomes one while a file is being edited (LS-8).

### 2.3 Confirmed defects

Each was reproduced on a minimal input against `main`.

| # | Language | Defect | Evidence |
|---|---|---|---|
| D1 | All | A declaration split along its statements gets no `declaration` back-reference, so whole-declaration selection never applies to it. It is only set when line windows do the cutting. | 0 of 288 split callables in the corpus carried it on all their fragments |
| D2 | Rust | `#[...]` attributes are separate tree nodes and are not attached to their item. Doc comment plus attributes end up in the previous fragment or alone. | 209 of 1,079 fragments (19.4%) end on a detached attribute |
| D3 | Rust | `impl fmt::Display for Config` is labelled `impl:Config`; the trait is lost. `const`, `static`, `union`, `macro_rules!` and item-level macro calls have no label. | Minimal input, label rules in `tree-sitter-boundaries.ts` |
| D4 | Go | Methods are labelled without receiver: `(*Server).ServeHTTP` and `(*Client).ServeHTTP` are both `method:ServeHTTP`. `const` and `var` blocks have no label. The `func_literal` rule cannot match, because a literal is never a direct child of a statement list. | Minimal inputs |
| D5 | Java | A call inside an annotation is taken for the method name: `@Scheduled(fixedRate = compute(5)) public void tick()` is labelled `method:compute`. | `parseJavaBoundaries` output |
| D6 | Java | Members of nested and inner classes get no label, and their statements no boundary. A nested class header becomes a one-line fragment. | Minimal input |
| D7 | Python | A fragment that continues method `long` and happens to contain a nested `def helper` is labelled `function:helper`. | Minimal input |
| D8 | Py, Java, Go, Rust | Go and Rust never descend into `if`, `for`, `match` or closure bodies. Python and Java stop at depth 2, the statements of a method. Anything deeper is cut by line count. | Code: `bodies`, `maxRefineDepth`, `MAX_DEPTH` |
| D9 | Py, Java, Go, Rust | One syntax error anywhere sends the whole file to line windows. | Minimal inputs |
| D10 | All | Priority terms are ASCII-only and do not split acronym boundaries: `HTTPServer` gives `httpserver`, `données` gives `donn` and `es`. | `lexicalTerms` output |

## 3. Design

### 3.1 One planner, many language profiles

**LS-1.** The recursive planner of `javascript-chunker.ts` becomes language-neutral.
It works on a minimal tree interface (node kind, start/end line, ordered children,
error flag). The TypeScript compiler tree and Tree-sitter trees are both adapted to
it. `chunkWithBoundaries` is kept only as a benchmark arm.

**LS-2.** Each language is one declarative profile:

| Field | Meaning |
|---|---|
| `id`, `version` | Name and chunker version; the version is part of evaluation identity as today |
| `detect` | Extensions, exact basenames, shebang interpreters |
| `parser` | TypeScript compiler, a pinned Tree-sitter grammar, or a named scanner |
| `leading` | Node kinds that attach to the next sibling: comments, attributes, decorators, annotations, `template<>` |
| `containers` | Node kinds whose body children are members (class, impl, namespace, module) |
| `callables` | Node kinds that are functions, methods, constructors, closures |
| `splitPoints` | Node kinds whose children may be separated when the parent is oversized (statement lists, match arms, switch cases, struct fields, object properties) |
| `label` | Rule giving kind, name and qualifier for a node |

Adding a language is a profile, a grammar file and a fixture directory. No planner change.

**LS-3.** Planner rules, identical for every language:

1. A node that fits the limits stays whole and is packed with neighbours up to the target size.
2. An oversized node is split along its children, recursively, with no fixed depth.
3. Line windows are the last resort, inside the smallest oversized node only.
4. Leading trivia never separates from the node it precedes. Fixes D2.
5. A small header (`class X {`, `impl Y {`, `def f(...):` plus docstring) is carried into the first fragment of the body, never emitted alone. Fixes the orphan header in D6.
6. Tiny remnants (closing braces, a lone `return`) merge into a neighbour.
7. Every fragment cut from a declaration records that declaration's line range, however it was cut. Fixes D1.

### 3.2 Labels

**LS-4.** A label names the symbol that starts on the fragment's first unit.
A fragment that starts inside a declaration is a continuation: it is labelled with
that declaration and marked as such, never with a nested symbol it happens to contain. Fixes D7.

**LS-5.** Labels are qualified by their container where the language has one:

| Language | Today | Target |
|---|---|---|
| Go | `method:ServeHTTP` | `method:Server.ServeHTTP` |
| Rust | `impl:Config`, `function:fmt` | `impl:Display for Config`, `method:Config.fmt` |
| Java | `method:run`, none for inner | `method:Outer.Inner.run`, `constructor:Outer` |
| Python | `method:save` | `method:Model.save` |
| C++ | none | `method:Parser::parse` |

**LS-6.** Each fragment also carries `symbols`: every declaration that starts in it.
It feeds the lexical priority only. It is not sent to Jev and is not part of the
score-cache key.

**LS-7.** Continuation labels and qualifiers change what Jev sees, and the label is
part of the score-cache key. Production JS/TS uses the local label; the
enclosing-chain policies exist only as E1 benchmark arms, and no E1 result is
recorded in the repository. LS-4 and LS-5 therefore ship per language only
after the live gate of section 9.3, and each language keeps the previous label policy
as a benchmark arm.

### 3.3 Syntax errors

**LS-8.** A file with syntax errors keeps structural fragments for every top-level
item that contains no error or missing node. Damaged items become line windows. The
whole file falls back only when damaged items cover more than half of its lines.
The result reports `fallback: 'parse_failure'`, as JS/TS does today. Fixes D9.

This is a prerequisite for C and C++: with the stock grammars, 27% of C files and
26% of C++ files in the corpus contain at least one error node, mostly from macros.

### 3.4 Line windows for everything else

**LS-9.** Line windows choose their cut instead of counting to 80. Within the last
40% of the target size, the cut goes to the line with the best boundary score:
a blank line followed by a line at the lowest indentation seen in the window, then
any blank line, then a dedent. Without a candidate, the current cut and overlap
apply. Overlap is dropped when the cut lands on a blank line at minimum indentation.

This needs no parser and covers every language without a profile. It ships as
`jevgrep-line-windows-2`; version 1 stays as an arm.

### 3.5 Language detection

**LS-10.** Detection order: exact basename (`Dockerfile`, `Makefile`, `Rakefile`,
`Gemfile`, `CMakeLists.txt`), then extension, then the shebang line for
extensionless files. `.h` is parsed as C, and as C++ when the C tree has a larger
damaged share. The detected profile is part of chunker identity.

### 3.6 Priority terms

**LS-11.** `lexicalTerms` accepts Unicode letters and splits acronym boundaries
(`HTTPServer` gives `http`, `server`; `parseXMLFile` gives `parse`, `xml`, `file`).
`PRIORITY_VERSION` is bumped. Scores and cache identity are unaffected. Fixes D10.

## 4. Per-language requirements

### 4.1 JS/TS (reference implementation)

- Move to the shared planner with no change in output. Byte-identical fragments on the corpus is the migration test.
- Continuation fragments carry the LS-4 label (36% to 50% have none today).
- Vue, Svelte and Astro single-file components: the `<script>` region is planned as JS/TS with original line numbers; template and style regions use the HTML and CSS profiles or LS-9.
- Hand-written `.d.ts` files are excluded as generated today (`inventory.ts`). Decide whether to keep that rule (section 11).

### 4.2 Python

- Parser: `tree-sitter-python` 0.25.0. 447 KB, 0 error files in 1,500, 5.1 ms per 1,000 lines. The scanner stays as an arm until the gate passes.
- Decorators and leading comments attach to their definition (kept).
- Docstring stays with the `def` or `class` line when the body is split.
- Classes, nested classes and nested functions at any depth, with qualified labels.
- Split points: statement lists of `if`/`elif`/`else`, `for`, `while`, `try`/`except`/`finally`, `with`, and `match` arms.
- Multi-line module assignments are labelled `variable:NAME`; `if __name__ == "__main__":` is labelled `main`.
- Add `.pyw`. Notebooks (`.ipynb`) stay out of scope.

### 4.3 Java

- Parser: `tree-sitter-java` 0.23.5. 404 KB, 0 error files in 347, 3.6 ms per 1,000 lines. The scanner stays as an arm.
- Label kinds: `class`, `interface`, `enum`, `record`, `annotation`, `method`, `constructor`, `field` (multi-line only), `initializer`.
- Method names come from the declaration node, never from token order. Fixes D5.
- Nested, inner, local and anonymous classes at any depth. Fixes D6.
- Javadoc and annotations attach to their declaration.
- Split points: block statements, `switch` cases and rules, lambda bodies, enum constant bodies.

### 4.4 Go

- Receiver type in method labels. Fixes D4.
- `const` and `var` blocks labelled by their first name; each spec of a grouped `type ( ... )` is a member.
- Split points: statement lists of `if`, `for`, `switch`, `select` and function literals; struct fields and interface methods.
- `//go:build` lines stay with the package clause; the cgo preamble stays with `import "C"`.
- Error recovery per LS-8.

### 4.5 Rust

- `attribute_item` and inner attributes are leading trivia. Fixes D2.
- Labels: `impl:Trait for Type`, `method:Type.name`, `const`, `static`, `union`, `macro:name` for `macro_rules!` and for item-level macro calls (`lazy_static!`, `thread_local!`). Fixes D3.
- `mod` nesting at any depth, so `mod tests { ... }` keeps one test per unit.
- Split points: block statements, `match` arms, closure bodies, struct and enum members.
- Error recovery per LS-8.

### 4.6 New languages with a grammar

All grammars below load in the pinned `web-tree-sitter` 0.27.1 and ship a prebuilt
WASM file in their npm package, except Swift. Error files are files with at least
one error node, measured on up to 1,500 corpus files per language.

| Language | Grammar | WASM size | Corpus error files | Parse time / 1,000 lines | Specific rules |
|---|---|---:|---:|---:|---|
| C | `tree-sitter-c` 0.24.1 | 611 KB | 27.0% | 4.5 ms | `#if`/`#ifdef` blocks are containers; multi-line `#define` labelled `macro:NAME`; `struct`, `union`, `enum`, `typedef` labelled; LS-8 mandatory |
| C++ | `tree-sitter-cpp` 0.23.4 | 3,354 KB | 25.7% (sample includes C headers) | 6.7 ms | Namespaces are containers at any depth; `template<>` is leading trivia; out-of-line methods labelled `method:Class::name`; LS-8 mandatory |
| PHP | `tree-sitter-php` 0.24.2 | 1,033 KB | 0.0% | 2.7 ms | Namespace, class, trait, interface, enum, method; `#[...]` attributes and docblocks attach; HTML outside `<?php` uses LS-9 |
| C# | `tree-sitter-c-sharp` 0.24.0 | 7,082 KB | not measured | not measured | Namespaces (block and file-scoped), class, struct, record, interface, property, `[Attribute]` attaches; `#region` is a split hint |
| Kotlin | `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0 | 3,360 KB | 1.6% | 6.5 ms | Class, object, companion, top-level and extension functions (`function:String.pad`); annotations attach |
| Ruby | `tree-sitter-ruby` 0.23.1 | 2,056 KB | 0.0% | 5.1 ms | Module, class, `def`; DSL blocks with a string or symbol argument (`describe`, `it`, `task`, `namespace`) labelled like JS callbacks |
| Bash | `tree-sitter-bash` 0.25.1 | 1,326 KB | 6.8% | 5.2 ms | Functions labelled; top-level commands grouped by blank-line paragraph |
| Swift | `tree-sitter-swift` 0.7.1 | no prebuilt WASM | not measured | not measured | Type, `extension:Type`, protocol, function, computed property; attributes attach; `// MARK:` is a split hint. Needs a reproducible WASM build, otherwise stays on LS-9 |

### 4.7 Structured text

| Format | Parser | Units and labels |
|---|---|---|
| Markdown | Scanner (headings, fenced code, front matter) | One section per heading, label `section:Install > Linux`; fenced code and tables are not cut while they fit |
| JSON, JSONC | `tree-sitter-json` 0.24.8, 5 KB | Top-level keys and array elements, label `key:scripts`, recursing into oversized values with a dotted path |
| YAML | `@tree-sitter-grammars/tree-sitter-yaml` 0.7.1, 184 KB | Documents and top-level keys, label `key:jobs.build` |
| TOML | `@tree-sitter-grammars/tree-sitter-toml` 0.7.0, 23 KB | Tables, label `table:tool.ruff` |
| CSS, SCSS | `tree-sitter-css` 0.25.0, 125 KB | Rule sets and at-rules, label `rule:.btn-primary` |
| SQL | Scanner (statement terminators, strings, comments) | One statement per unit, label `table:users` or `function:name` for `CREATE` |
| Dockerfile, Makefile | Scanners | Build stages (`stage:builder`), targets (`target:test`) |
| HTML | LS-9, with `<script>` and `<style>` regions delegated | No labels |

## 5. Invariants that do not change

- Every non-blank line belongs to at least one fragment.
- Fragments are exact slices of the snapshot. No printer, no normalisation.
- Same bytes, limits and versions give the same fragments in the same order.
- No install script and no native addon. Grammars are vendored WASM with their licence file.
- A grammar is compiled on first use of its language only.
- A profile version bump invalidates preparation and score caches for that language alone.

## 6. Packaging

Vendored WASM today: 1.26 MB (Go, Rust).

| Set | Adds |
|---|---:|
| Python, Java | 0.83 MB |
| Structured text (JSON, YAML, TOML, CSS) | 0.33 MB |
| C, PHP, Bash | 2.90 MB |
| Ruby | 2.01 MB |
| C++, Kotlin | 6.56 MB |
| C# | 6.92 MB |

**LS-12.** Each vendored grammar is listed in a manifest with package, version and
SHA-256, checked by a test. Whether the large grammars ship in the main package or
in optional grammar packages is an open decision (section 11).

## 7. Performance budget

- Syntax chunking of a language costs at most 1.5 times its line-window time per 1,000 lines on the corpus. Today's total is 13 to 19 ms per 1,000 lines for the languages with a syntax chunker; Tree-sitter parsing alone measured 2.7 to 6.7 ms.
- Grammar load stays under 50 ms (measured: 11 ms or less).
- Fragment count for a language that already has a syntax chunker does not grow by more than 10%, because each fragment is provider input.

## 8. Compatibility

- `PreparedFragment` gains `symbols` and a continuation flag; both optional, so captured pools still replay.
- The preparation cache record gains the same fields under a new record version.
- `SyntaxLanguage` becomes the list of profile ids. `inspect` and the coverage report name the profile and its fallback share.

## 9. Verification

### 9.1 Structural benchmark (`npm run bench:languages`, offline)

A pinned corpus, one or more repositories per language. The baseline of section 2.2 used:
`django/django@f14af5a`, `spring-projects/spring-petclinic@500158f`, `google/gson@d9b5079`,
`caddyserver/caddy@679806f`, `sharkdp/bat@4bd5c5b`, `tokio-rs/axum@bfa6686`,
`expressjs/express@43fca52`, `vuejs/core@44234e8`, `redis/redis@f7c38e3`, `fmtlib/fmt@3be6709`,
`laravel/framework@14b8b06`, `sinatra/sinatra@2e3f791`, `square/okio@f0e3f47`,
`Alamofire/Alamofire@dea4bab`. A C# repository has to be added.

| Metric | Today | Gate for a profiled language |
|---|---|---|
| Uncovered non-blank lines | 0 | 0 |
| Fragments ending on a detached attribute or annotation | 209 (Rust); on line windows 17 (Kotlin), 15 (PHP), 5 (Swift) | 0 |
| Split callables with a declaration back-reference | 0% | 100% |
| Fragments starting mid-block | 1% to 15% with a syntax chunker; 43% to 59% for C, C++, PHP, Kotlin, Swift, Ruby | 15% or less |
| Fragments starting mid-block, formats left on LS-9 | 66% (HTML) | Half of today's value or less |
| Continuation fragments without label | 36% to 100% | 0% |
| Fragments of 3 lines or fewer | 0.1% to 5.2% | 3% or less |
| Files with any parse fallback, well-formed corpus | 0.2% (10 of 4,283) | 1% or less; for C and C++, 10% or less of lines |

### 9.2 Golden fixtures (unit tests)

`tests/fixtures/languages/<profile>/`: source files with the expected ranges and
labels. Each profile covers at least: leading trivia, nested containers, an oversized
callable, an oversized single statement, a file with one local syntax error, and the
constructs named in section 4 for that language. Each defect D1 to D10 gets a
regression test.

### 9.3 Live retrieval gate

A profile, or a label policy change, becomes the default only when, on the existing
`bench:real --chunker <arm>` protocol with four repetitions:

- held-out R@5 and MRR are not below the current default by more than one standard deviation;
- input tokens per run do not rise by more than 5%.

Task sets: the existing Python, JS/TS and Go/Rust sets, and the Java tasks of the
hard set. New sets for C, C++,
PHP and Ruby are to be imported from SWE-bench Multilingual with the existing
importer, which needs comment and import classification rules for each of them,
subject to confirming at import time that enough tasks qualify. Kotlin,
Swift and C# have no such source: they pass on 9.1 and 9.2 plus a small hand-written
set in the style of `hand-go-rust-reliability-1.json`.

## 10. Delivery order

| Phase | Content | Risk |
|---|---|---|
| 0 | Fix D1 to D7 inside the current chunkers; add `bench:languages` and the regression fixtures | Low. Bumps five chunker versions, so those score caches refill once |
| 1 | Shared planner and profiles (LS-1 to LS-3, LS-8); JS/TS, Go and Rust move to it | Medium. JS/TS output must stay byte-identical |
| 2 | Python and Java on Tree-sitter behind an arm, then default if 9.3 passes | Medium |
| 3 | Line windows 2 (LS-9), detection (LS-10), priority terms (LS-11) | Low |
| 4 | New grammar languages, one per change, in the order chosen in section 11 | Low each |
| 5 | Structured text profiles | Low |
| 6 | Label policy LS-4, LS-5 per language through 9.3 | Depends on live results |

## 11. Open decisions

1. **Large grammars.** Ship everything in the main package (about 21 MB of WASM in total), or keep the main package under about 5 MB and publish C++, C#, Kotlin, Ruby and Swift as optional grammar packages that are used when installed.
2. **Order of new languages.** Proposed: C, C++, PHP, C#, Kotlin, Ruby, Bash, Swift. It should follow the repositories JevGrep is actually used on.
3. **Python and Java parser.** Recommended: Tree-sitter, because recursion, recovery and qualified names need a tree. The alternative is to patch the two scanners and keep them.
4. **`.d.ts` files.** Keep excluding all of them as generated, or admit hand-written ones.
5. **Swift.** Accept a WASM built in this repository from a pinned grammar commit, or leave Swift on LS-9.
