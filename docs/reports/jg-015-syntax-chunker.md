# JG-015 — Syntax parser qualification

20 September 2026, Node.js 24.15.0. The lexical draft has been replaced by the
syntax-only API of `typescript-parser@npm:typescript@6.0.2`. The build compiler
remains `typescript@7.0.2`; scripts invoke its entry point explicitly because the
npm alias also supplies a `tsc` executable.

## Decision and reproducible probe

Microsoft documents the classic compiler API for TypeScript 6.0 and earlier:
[Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
The pinned 7.0.2 package has no `createSourceFile`; its unstable scanner does not
provide the expected numeric positions. This is not evidence against a separate
supported parser. Run `node scripts/probe-typescript-parser.ts --json` to compare
both packages in isolated subprocesses. The 6.0.2 alias parses the sample successfully.
The exact npm tarball and integrity are retained in the lockfile.

## Implementation and qualification

`createSourceFile` consumes only the already authorized snapshot. No Program,
filesystem host, module resolver, project plugin, emitter or type checker is created.
Parser diagnostics (a checked internal field of this pinned API) trigger the
existing line-window fallback. Unsupported newer syntax therefore remains covered.

AST statements and class members propose boundaries to depth two. Leading comments
and decorators stay attached when a legal fragment can hold them. Deeper or oversized
constructs use bounded windows. Every returned fragment remains a contiguous
original snapshot slice; labels never replace source.

Tests cover all eight JS/TS extensions, route registration, imports that cannot be
resolved, grammatically invalid but balanced source, malformed JSX, regex/templates,
large declarations, BOM/CRLF, Unicode and decorators. They assert nonblank-line
coverage, exact bytes, deterministic ordering and active fragment limits.
This qualifies local syntax preparation, not retrieval quality or provider batching.
