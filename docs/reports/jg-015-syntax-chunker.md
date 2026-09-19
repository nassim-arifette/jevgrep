# JG-015 — JS/TS syntax chunking: parser decision and limits

Prepared 2026-09-19, Node.js 24.15.0, Windows 11. The integrated lexical scanner is
provisional. JG-015 remains open; this report records the draft's behaviour and the
parser decision still required before qualification.

## The recommendation, and what the pinned package offers

The specification (§3, §5.4) recommends the TypeScript compiler's **syntax** parser for
JS/TS chunking, explicitly as a recommended supporting choice, and warns that the
document "does not assume unreleased or unverified package interfaces".

The package pinned by JG-001 is `typescript@7.0.2`. The draft author reported problems
with its syntax APIs, but no reproducible subprocess probe was committed. Those notes
do not establish that a supported syntax parser is unavailable or unsafe. Qualify a
supported API and compare it with this scanner before making the dependency decision.
A second pinned parser dependency is possible; offline tests do not rule it out.

## What was implemented instead

[`src/source/javascript-boundaries.ts`](../../src/source/javascript-boundaries.ts) is a
purpose-built lexical scanner. It reads the source as **data**: it never imports,
evaluates, compiles or type-checks anything (requirement R11). It tracks:

- line and block comments, and the comment run that precedes a declaration;
- single- and double-quoted strings with escapes;
- template literals including nested `${ … }` expression holes;
- regular-expression literals, distinguished from division by the previous token;
- JSX elements, attributes, children and expression containers in `.jsx` / `.tsx`;
- `()`, `[]`, `{}` nesting depth, to know what is top level and what is a member.

It records *boundary lines* with their depth. [`src/source/chunker.ts`](../../src/source/chunker.ts)
turns those boundaries into a partition of the file's lines, packs neighbouring small
units up to the target size, and splits an oversized declaration by deeper boundaries
first and by line windows last. Windows and their limits are JG-012's
([`src/source/line-windows.ts`](../../src/source/line-windows.ts)); non-JS text and any
JS/TS file the scanner refuses go through that module unchanged.

## Guarantees and limits

Exercised on fixtures in [`tests/syntax-chunker.test.ts`](../../tests/syntax-chunker.test.ts):

- every non-blank line of a successfully prepared file belongs to at least one fragment;
- each fragment is an exact contiguous slice of the snapshot — no printer, no
  re-indentation, no stitching of non-adjacent lines;
- deterministic identities, sizes and order for the same snapshot and limits;
- the eight documented extensions (`.js .jsx .ts .tsx .mjs .cjs .mts .cts`) are handled,
  and top-level registrations (`app.post(…)`, `app.listen(…)`) stay searchable even when
  they sit outside a named function;
- leading documentation comments travel with the declaration they describe;
- detected lexical failures fall back to line windows with `parse_failure`; this
  does not establish grammar-level validation of every malformed JS/TS program;
- a line that cannot fit any legal fragment excludes the file with
  `unsupported_long_line` rather than being truncated.

Known limits, stated rather than papered over:

- the scanner knows tokens, not grammar. It cannot tell a TypeScript generic `<T>` from a
  JSX element, so JSX scanning is enabled only for `.jsx` and `.tsx`;
- structural labels (`function:handle`) are a first-token heuristic; they are metadata,
  never returned evidence;
- a file whose braces are unbalanced for a reason the scanner cannot see (an exotic
  pre-processor, for example) is reported as a parse failure and windowed — correct, but
  a lower-quality fragmentation;
- boundaries are recorded to depth 2. A deeply nested oversized construct is split by
  line windows, not by its inner structure.

## Required qualification

Before closing JG-015, qualify a supported syntax-only parser on the pinned runtime
and compare it with this draft on malformed files, JSX, templates and large declarations.
Record the dependency choice and reproducible probes. Later retrieval measurements
must distinguish fragmentation quality from provider relevance; the fallback count
alone does not establish a sound syntax parser.
