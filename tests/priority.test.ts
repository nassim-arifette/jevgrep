import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PATH_ORDER, lexicalTerms, prioritizeFiles, prioritizeFragments } from '../src/priority.ts';

const fragment = (path: string, startLine: number, text: string, label: string | null = null) => ({ path, startLine, endLine: startLine + 2, text, label });

const FRAGMENTS = [
  fragment('src/a.ts', 1, 'export const unrelated = 1;'),
  fragment('src/b.ts', 1, 'function render() { return null; }'),
  fragment('src/session/cache.ts', 10, 'export function invalidateSession(id) { store.delete(id); }', 'function:invalidateSession'),
  fragment('src/c.ts', 1, 'const other = 2;'),
  fragment('src/d.ts', 1, 'let more = 3;'),
];

test('identifier terms split camelCase and snake_case', () => {
  assert.deepEqual(lexicalTerms('invalidateSession max_redirects'), ['invalidatesession', 'invalidate', 'session', 'max_redirects', 'max', 'redirects']);
});

test('path order sorts by path and offsets, like the batch builder', () => {
  assert.deepEqual(prioritizeFragments(FRAGMENTS, 'where is the session invalidated', PATH_ORDER).map((f) => f.path),
    ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/session/cache.ts']);
});

test('priority puts lexical, filename and symbol matches first and keeps every candidate', () => {
  const ordered = prioritizeFragments(FRAGMENTS, 'Where is a session invalidated in the cache?', { kind: 'priority', reserve: 0 });
  assert.equal(ordered[0]?.path, 'src/session/cache.ts');
  assert.equal(ordered.length, FRAGMENTS.length);
  assert.deepEqual(new Set(ordered), new Set(FRAGMENTS));
});

test('a reserve interleaves a path-order sweep of the remaining candidates', () => {
  const ordered = prioritizeFragments(FRAGMENTS, 'session cache', { kind: 'priority', reserve: 0.5 });
  assert.equal(ordered.length, FRAGMENTS.length);
  assert.equal(new Set(ordered).size, FRAGMENTS.length);
  assert.equal(ordered[0]?.path, 'src/session/cache.ts');
  assert.equal(ordered[1]?.path, 'src/a.ts');
});

test('the order is deterministic for equal inputs', () => {
  const order = { kind: 'priority', reserve: 0.25 } as const;
  assert.deepEqual(prioritizeFragments(FRAGMENTS, 'session', order), prioritizeFragments([...FRAGMENTS].reverse(), 'session', order));
});

test('files are ordered from their paths alone', () => {
  const files = ['lib/util.py', 'lib/sessions.py', 'docs/index.rst'].map((relativePath) => ({ relativePath }));
  assert.equal(prioritizeFiles(files, 'Why do sessions keep a cookie?', { kind: 'priority', reserve: 0 })[0]?.relativePath, 'lib/sessions.py');
  assert.deepEqual(prioritizeFiles(files, 'x', PATH_ORDER), files);
});
