import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countReferenceTokens } from '../src/response/token-counter.ts';
import { chunkSnapshot, uncoveredNonBlankLines, usesSyntaxChunking } from '../src/source/chunker.ts';
import type { ChunkResult, PreparedFragment } from '../src/source/chunker.ts';
import { DEFAULT_WINDOW_LIMITS } from '../src/source/line-windows.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import type { SourceSnapshot } from '../src/source/snapshot.ts';

/**
 * JS/TS syntax chunking with the line-window fallback (JG-015, specification 5.4).
 *
 * The acceptance criteria drive these tests: the eight JS/TS extensions are covered,
 * top-level registrations stay searchable, every non-blank line of a prepared file
 * belongs to a fragment, identities are deterministic, a malformed file falls back
 * with a reason instead of disappearing, and every fragment is an exact snapshot
 * slice produced without importing, compiling or type-checking the source.
 */

function snapshotOf(path: string, text: string): SourceSnapshot {
  return createSnapshot(path, `/tmp/${path}`, Buffer.from(text, 'utf8'), countReferenceTokens);
}

function fragmentsOf(result: ChunkResult): readonly PreparedFragment[] {
  assert.equal(result.kind, 'fragments');
  if (result.kind !== 'fragments') {
    throw new Error('unreachable');
  }
  return result.fragments;
}

const ROUTE_MODULE = `import express from 'express';
import { policy } from './policy.ts';

/** Registers the audit routes on a shared app instance. */
export function registerRoutes(app) {
  app.post('/subscriptions/:id', async (request, response) => {
    await policy.apply(request.params.id);
    response.status(204).end();
  });
}

// A top-level registration outside any named function.
const app = express();
registerRoutes(app);
app.listen(process.env.PORT ?? 3000);
`;

test('the eight JavaScript and TypeScript extensions use the syntax chunker', () => {
  for (const extension of ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']) {
    assert.equal(usesSyntaxChunking(`src/module${extension}`), true, `${extension} must be parsed`);
    const snapshot = snapshotOf(`src/module${extension}`, ROUTE_MODULE);
    const result = chunkSnapshot(snapshot);
    assert.equal(result.kind, 'fragments');
    if (result.kind !== 'fragments') {
      continue;
    }
    assert.equal(result.strategy, 'syntax', `${extension} should not need the fallback`);
    assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), []);
  }
  assert.equal(usesSyntaxChunking('config/settings.json'), false);
});

test('top-level registrations stay searchable outside any named function', () => {
  const snapshot = snapshotOf('src/routes.ts', ROUTE_MODULE);
  const fragments = fragmentsOf(chunkSnapshot(snapshot));
  const covering = fragments.find((fragment) => fragment.text.includes('app.listen('));
  assert.ok(covering !== undefined, 'the top-level listen call belongs to a fragment');
  assert.ok(fragments.some((fragment) => fragment.text.includes("app.post('/subscriptions/:id'")));
});

test('leading comments stay attached to the declaration they document', () => {
  const text = `const before = 1;

/**
 * Explains the handler below.
 */
export function handler() {
  return before;
}
`;
  const snapshot = snapshotOf('src/handler.ts', text);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, { ...DEFAULT_WINDOW_LIMITS, targetTokens: 12, maxTokens: 400 }));
  const withHandler = fragments.find((fragment) => fragment.text.includes('export function handler'));
  assert.ok(withHandler !== undefined);
  assert.ok(withHandler.text.includes('Explains the handler below'),
    'the documentation comment travels with its declaration');
});

test('every fragment is an exact slice of the snapshot and respects the active limits', () => {
  const body = Array.from({ length: 60 }, (_, index) => `  const value${String(index)} = compute(${String(index)});`).join('\n');
  const text = `export function large() {\n${body}\n}\n\nexport const tail = 1;\n`;
  const snapshot = snapshotOf('src/large.ts', text);
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  const fragments = fragmentsOf(chunkSnapshot(snapshot, limits));

  assert.ok(fragments.length > 1, 'an oversized declaration is split');
  for (const fragment of fragments) {
    assert.equal(fragment.text, snapshot.sliceLines(fragment.startLine, fragment.endLine).text);
    assert.ok(fragment.tokenCount <= limits.maxTokens, `fragment ${fragment.id} exceeds the token limit`);
    assert.ok(fragment.byteCount <= limits.maxBytes, `fragment ${fragment.id} exceeds the byte limit`);
    assert.ok(fragment.startLine <= fragment.endLine);
  }
  assert.deepEqual(uncoveredNonBlankLines(snapshot, fragments), []);
});

test('the same snapshot and limits always produce the same fragments in the same order', () => {
  const snapshot = snapshotOf('src/routes.ts', ROUTE_MODULE);
  const first = fragmentsOf(chunkSnapshot(snapshot));
  const second = fragmentsOf(chunkSnapshot(snapshot));
  assert.deepEqual(
    first.map((fragment) => [fragment.id, fragment.startLine, fragment.endLine, fragment.tokenCount]),
    second.map((fragment) => [fragment.id, fragment.startLine, fragment.endLine, fragment.tokenCount]),
  );
});

test('a malformed source falls back to line windows with a reported reason', () => {
  const snapshot = snapshotOf('src/broken.ts', 'export function broken( {\n  const unterminated = "oops;\n');
  const result = chunkSnapshot(snapshot);
  assert.equal(result.kind, 'fragments');
  if (result.kind !== 'fragments') {
    return;
  }
  assert.equal(result.strategy, 'line-window');
  assert.equal(result.fallback, 'parse_failure');
  assert.ok(result.fragments.length > 0, 'a malformed file does not disappear silently');
  assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), []);
});

test('regular expressions, template literals and JSX do not derail the scanner', () => {
  const tricky = `const pattern = /\\/(?:a|b)[/]c/g;
const template = \`user:\${userId}/\${pattern.source}\`;
export function render(userId) {
  return template;
}
`;
  const snapshot = snapshotOf('src/tricky.ts', tricky);
  const result = chunkSnapshot(snapshot);
  assert.equal(result.kind === 'fragments' && result.fallback, null, 'valid code must not need the fallback');

  const jsx = `export function Panel({ items }) {
  return (
    <section className="panel">
      <p>it's a list of {items.length} items</p>
      {items.map((item) => <Row key={item.id} item={item} />)}
    </section>
  );
}
`;
  const jsxSnapshot = snapshotOf('src/Panel.tsx', jsx);
  const jsxResult = chunkSnapshot(jsxSnapshot);
  assert.equal(jsxResult.kind, 'fragments');
  if (jsxResult.kind !== 'fragments') {
    return;
  }
  assert.deepEqual(uncoveredNonBlankLines(jsxSnapshot, jsxResult.fragments), []);
  assert.ok(jsxResult.fragments.some((fragment) => fragment.text.includes("it's a list of")));
});

test('a line no legal fragment can hold is reported, never truncated', () => {
  const snapshot = snapshotOf('src/minified.ts', `const data = "${'a'.repeat(20_000)}";\n`);
  const result = chunkSnapshot(snapshot);
  assert.equal(result.kind, 'unsupported-long-line');
  if (result.kind !== 'unsupported-long-line') {
    return;
  }
  assert.equal(result.reason, 'unsupported_long_line');
  assert.equal(result.line, 1);
});

test('non-JS text uses bounded line windows through the JG-012 chunker', () => {
  const markdown = Array.from({ length: 200 }, (_, index) => `line ${String(index)} of the runbook`).join('\n');
  const snapshot = snapshotOf('docs/runbook.md', `${markdown}\n`);
  const result = chunkSnapshot(snapshot);
  assert.equal(result.kind, 'fragments');
  if (result.kind !== 'fragments') {
    return;
  }
  assert.equal(result.strategy, 'line-window');
  assert.ok(result.fragments.length > 1);
  assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), []);
  for (const fragment of result.fragments) {
    assert.ok(fragment.endLine - fragment.startLine + 1 <= DEFAULT_WINDOW_LIMITS.maxLines);
  }
});

test('fragment metadata carries the identity a cache and a report need', () => {
  const snapshot = snapshotOf('src/routes.ts', ROUTE_MODULE);
  const [fragment] = fragmentsOf(chunkSnapshot(snapshot));
  assert.ok(fragment !== undefined);
  assert.equal(fragment.path, 'src/routes.ts');
  assert.equal(fragment.sha256, snapshot.sha256);
  assert.ok(fragment.chunker.length > 0, 'the chunker version is part of evaluation identity');
  assert.ok(fragment.byteEnd > fragment.byteStart);
  assert.equal(fragment.byteCount, fragment.byteEnd - fragment.byteStart);
});
