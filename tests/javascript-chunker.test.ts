import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countReferenceTokens } from '../src/response/token-counter.ts';
import { SYNTAX_CHUNKER_VERSIONS, chunkSnapshot, chunkerIdentityFor, uncoveredNonBlankLines } from '../src/source/chunker.ts';
import type { ChunkResult, PreparedFragment } from '../src/source/chunker.ts';
import { DEFAULT_WINDOW_LIMITS } from '../src/source/line-windows.ts';
import type { WindowLimits } from '../src/source/line-windows.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import type { SourceSnapshot } from '../src/source/snapshot.ts';

/**
 * Recursive JS/TS chunking and enclosing-symbol context (roadmap section 7, E1).
 *
 * An oversized symbol is split along its own syntax tree, every fragment derived from
 * it carries the chain of enclosing symbols as metadata, returned text stays an exact
 * snapshot slice, and a local syntax error only degrades the statements it touches.
 */

const SMALL: WindowLimits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 120, maxTokens: 240, targetLines: 14, maxLines: 24 };

function snapshotOf(path: string, text: string): SourceSnapshot {
  return createSnapshot(path, `/tmp/${path}`, Buffer.from(text, 'utf8'), countReferenceTokens);
}

function fragmentsOf(result: ChunkResult): readonly PreparedFragment[] {
  if (result.kind !== 'fragments') throw new Error(`expected fragments, got ${result.kind}`);
  return result.fragments;
}

function assertExactAndCovered(snapshot: SourceSnapshot, fragments: readonly PreparedFragment[], limits: WindowLimits): void {
  for (const fragment of fragments) {
    assert.equal(fragment.text, snapshot.sliceLines(fragment.startLine, fragment.endLine).text);
    assert.ok(fragment.tokenCount <= limits.maxTokens, `${fragment.startLine}-${fragment.endLine} exceeds maxTokens`);
    assert.ok(fragment.endLine - fragment.startLine + 1 <= limits.maxLines);
  }
  assert.deepEqual(uncoveredNonBlankLines(snapshot, fragments), []);
}

const statements = (prefix: string, count: number, indent: string): string =>
  Array.from({ length: count }, (_, index) => `${indent}const ${prefix}${String(index)} = compute(${String(index)}, options.scale * ${String(index)});`).join('\n');

const LARGE_FUNCTION = `import { compute } from './math.ts';

export async function reconcileLedger(entries, options) {
${statements('first', 18, '  ')}
  if (options.strict) {
${statements('strict', 18, '    ')}
  }
${statements('last', 18, '  ')}
  return entries;
}
`;

const ENCLOSING = { javascriptContext: 'enclosing' } as const;

test('with enclosing context, every fragment of an oversized function names the function', () => {
  const snapshot = snapshotOf('src/ledger.ts', LARGE_FUNCTION);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, SMALL, ENCLOSING));
  assertExactAndCovered(snapshot, fragments, SMALL);
  const inside = fragments.filter((fragment) => fragment.startLine > 3);
  assert.ok(inside.length >= 3, 'the function is split recursively');
  for (const fragment of inside) {
    assert.match(fragment.label ?? '', /function:reconcileLedger\(entries, options\)/);
  }
  assert.ok(fragments.every((fragment) => fragment.chunker === SYNTAX_CHUNKER_VERSIONS.javascript));
});

test('the signature is never left alone in its own fragment', () => {
  const snapshot = snapshotOf('src/ledger.ts', LARGE_FUNCTION);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, SMALL));
  const header = fragments.find((fragment) => fragment.startLine <= 3 && fragment.endLine >= 3)!;
  assert.ok(header.endLine > 4, 'the signature stays with the first statements of the body');
});

test('the default local policy keeps the same boundaries and labels only symbol starts', () => {
  const snapshot = snapshotOf('src/ledger.ts', LARGE_FUNCTION);
  const enclosing = fragmentsOf(chunkSnapshot(snapshot, SMALL, ENCLOSING));
  const compact = fragmentsOf(chunkSnapshot(snapshot, SMALL, { javascriptContext: 'compact' }));
  const local = fragmentsOf(chunkSnapshot(snapshot, SMALL));
  assert.deepEqual(compact.map((fragment) => [fragment.startLine, fragment.endLine]), enclosing.map((fragment) => [fragment.startLine, fragment.endLine]));
  assert.ok(compact.every((fragment) => fragment.label == null || !fragment.label.includes('(')), 'compact labels carry no signature');
  const start = local.find((fragment) => fragment.text.includes('export async function reconcileLedger'))!;
  assert.equal(start.label, 'function:reconcileLedger');
  assert.deepEqual(local.map((fragment) => [fragment.startLine, fragment.endLine]), enclosing.map((fragment) => [fragment.startLine, fragment.endLine]));
  assert.ok(local.filter((fragment) => fragment.label != null).length < enclosing.filter((fragment) => fragment.label != null).length);
});

test('methods of a large class carry the class and the method, with decorators and comments attached', () => {
  const methods = Array.from({ length: 4 }, (_, index) => `  /** Applies step ${String(index)}. */
  @trace('step${String(index)}')
  step${String(index)}(input: number): number {
${statements(`value${String(index)}_`, 10, '    ')}
    return input;
  }`).join('\n\n');
  const text = `@injectable()\nexport class Pipeline {\n${methods}\n}\n`;
  const snapshot = snapshotOf('src/pipeline.ts', text);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, SMALL, ENCLOSING));
  assertExactAndCovered(snapshot, fragments, SMALL);
  for (let index = 0; index < 4; index += 1) {
    const start = fragments.find((fragment) => fragment.text.includes(`step${String(index)}(input: number)`))!;
    assert.match(start.label ?? '', new RegExp(`class:Pipeline.*method:step${String(index)}`));
    assert.ok(start.text.includes(`@trace('step${String(index)}')`), 'decorator stays with its method');
    assert.ok(start.text.includes(`Applies step ${String(index)}.`), 'doc comment stays with its method');
  }
});

test('nested callbacks and named arrow functions are labelled', () => {
  const text = `const handleRequest = async (request) => {
${statements('a', 16, '  ')}
};

describe('ledger', () => {
  it('reconciles entries', () => {
${statements('b', 16, '    ')}
  });
  it('rejects duplicates', () => {
${statements('c', 16, '    ')}
  });
});
`;
  const snapshot = snapshotOf('src/ledger.test.js', text);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, SMALL, ENCLOSING));
  assertExactAndCovered(snapshot, fragments, SMALL);
  const labelAt = (needle: string): string => fragments.find((fragment) => fragment.text.includes(needle))!.label ?? '';
  assert.match(labelAt('const a3 ='), /handleRequest\(request\)/);
  assert.match(labelAt('const b3 ='), /callback:describe\("ledger"\).*callback:it\("reconciles entries"\)/);
  assert.match(labelAt('const c3 ='), /callback:it\("rejects duplicates"\)/);
  const local = fragmentsOf(chunkSnapshot(snapshot, SMALL));
  assert.ok(local.some((fragment) => fragment.label === 'function:handleRequest'));
  assert.ok(local.some((fragment) => fragment.label === 'callback:it("rejects duplicates")'));
});

test('a React component is labelled and JSX that fits stays in one fragment', () => {
  const text = `import { useState } from 'react';

export function AccountPanel({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <header onClick={() => setOpen(!open)}>{account.name}</header>
      {open && (
        <ul>
          {account.entries.map((entry) => <li key={entry.id}>{entry.label}</li>)}
        </ul>
      )}
    </section>
  );
}

export const Badge = ({ count }: { count: number }) => <span className="badge">{count}</span>;
`;
  const snapshot = snapshotOf('src/AccountPanel.tsx', text);
  const fragments = fragmentsOf(chunkSnapshot(snapshot, DEFAULT_WINDOW_LIMITS));
  assertExactAndCovered(snapshot, fragments, DEFAULT_WINDOW_LIMITS);
  const panel = fragments.find((fragment) => fragment.text.includes('<section'))!;
  assert.ok(panel.text.includes('</section>'), 'JSX that fits is not split');
  assert.match(panel.label ?? '', /component:AccountPanel/);
  const badge = snapshotOf('src/Badge.tsx', 'export const Badge = ({ count }: { count: number }) => <span className="badge">{count}</span>;\n');
  assert.match(fragmentsOf(chunkSnapshot(badge, DEFAULT_WINDOW_LIMITS))[0]!.label ?? '', /component:Badge/);
});

test('a syntax error stays local: other statements keep their structure and the fallback is reported', () => {
  const healthy = (name: string): string => `export function ${name}(input) {\n${statements(name, 14, '  ')}\n  return input;\n}\n`;
  const text = `${healthy('alpha')}\n${healthy('beta')}\nexport function broken(input) {\n  const value = input.map((item => item.id);\n  return value;\n}\n\n${healthy('gamma')}`;
  const snapshot = snapshotOf('src/partial.js', text);
  const result = chunkSnapshot(snapshot, SMALL);
  assert.equal(result.kind, 'fragments');
  if (result.kind !== 'fragments') return;
  assert.equal(result.strategy, 'syntax');
  assert.equal(result.fallback, 'parse_failure');
  assertExactAndCovered(snapshot, result.fragments, SMALL);
  for (const name of ['alpha', 'beta', 'gamma']) {
    const start = result.fragments.find((fragment) => fragment.text.includes(`function ${name}(input)`))!;
    assert.match(start.label ?? '', new RegExp(`function:${name}`));
  }
  const damaged = result.fragments.find((fragment) => fragment.text.includes('item => item.id'))!;
  assert.equal(damaged.label, null, 'a damaged statement gets no structural label');
});

test('a file that is mostly broken falls back to plain line windows', () => {
  const text = `export function broken(input) {\n  const value = input.map((item => item.id);\n${statements('x', 20, '  ')}\n  return value;\n}\n`;
  const snapshot = snapshotOf('src/broken.js', text);
  const result = chunkSnapshot(snapshot, SMALL);
  assert.equal(result.kind, 'fragments');
  if (result.kind !== 'fragments') return;
  assert.equal(result.strategy, 'line-window');
  assert.equal(result.fallback, 'parse_failure');
  assertExactAndCovered(snapshot, result.fragments, SMALL);
});

test('recursive output is deterministic and the boundary change is versioned', () => {
  const snapshot = snapshotOf('src/ledger.ts', LARGE_FUNCTION);
  assert.deepEqual(chunkSnapshot(snapshot, SMALL), chunkSnapshot(snapshotOf('src/ledger.ts', LARGE_FUNCTION), SMALL));
  assert.equal(SYNTAX_CHUNKER_VERSIONS.javascript, 'jevgrep-typescript-6.0.2-3');
  assert.ok(chunkerIdentityFor('src/ledger.ts').includes(SYNTAX_CHUNKER_VERSIONS.javascript));
});
