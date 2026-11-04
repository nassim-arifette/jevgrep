import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countReferenceTokens } from '../src/response/token-counter.ts';
import {
  chunkSnapshot, chunkerIdentityFor, SYNTAX_CHUNKER_VERSIONS, syntaxLanguageOf, uncoveredNonBlankLines,
} from '../src/source/chunker.ts';
import type { ChunkResult, PreparedFragment } from '../src/source/chunker.ts';
import { DEFAULT_WINDOW_LIMITS } from '../src/source/line-windows.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import type { SourceSnapshot } from '../src/source/snapshot.ts';
import { parseTreeSitterBoundaries } from '../src/source/tree-sitter-boundaries.ts';

/**
 * Go and Rust syntax chunking from vendored Tree-sitter grammars: fragments stay exact
 * snapshot slices covering every non-blank line, and a tree with errors falls back to
 * line windows with a reported reason.
 */

function snapshotOf(path: string, text: string): SourceSnapshot {
  return createSnapshot(path, `/tmp/${path}`, Buffer.from(text, 'utf8'), countReferenceTokens);
}

function syntaxFragments(result: ChunkResult): readonly PreparedFragment[] {
  assert.ok(result.kind === 'fragments');
  assert.equal(result.strategy, 'syntax');
  assert.equal(result.fallback, null);
  return result.fragments;
}

function assertExact(snapshot: SourceSnapshot, fragments: readonly PreparedFragment[]): void {
  for (const fragment of fragments) {
    assert.equal(fragment.text, snapshot.sliceLines(fragment.startLine, fragment.endLine).text);
  }
  assert.deepEqual(uncoveredNonBlankLines(snapshot, fragments), []);
}

const SMALL = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 20, maxTokens: 400 };

const GO_MODULE = `package accounts

import "fmt" // formatting

// Account holds a balance.
// It is not safe for concurrent use.
type Account struct{ balance int }

func (a *Account) Deposit(amount int) {
\tif amount <= 0 {
\t\tpanic("non-positive deposit")
\t}
\ta.balance += amount
}

func Describe(a *Account) string { return fmt.Sprintf("%d", a.balance) }
`;

const RUST_MODULE = `use std::fmt;

/// A 2D point.
pub struct Point { x: i32, y: i32 }

impl Point {
    /// The origin.
    pub fn origin() -> Self { Point { x: 0, y: 0 } }

    fn norm(&self) -> i32 {
        let squared = self.x * self.x + self.y * self.y;
        squared
    }
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { write!(f, "({}, {})", self.x, self.y) }
}
`;

test('Go and Rust extensions select their own versioned Tree-sitter chunker', () => {
  assert.equal(syntaxLanguageOf('cmd/main.go'), 'go');
  assert.equal(syntaxLanguageOf('src/lib.RS'), 'rust');
  assert.match(SYNTAX_CHUNKER_VERSIONS.go, /tree-sitter-go-0\.25\.0/);
  assert.match(SYNTAX_CHUNKER_VERSIONS.rust, /tree-sitter-rust-0\.24\.0/);
  assert.ok(chunkerIdentityFor('a.go').includes(SYNTAX_CHUNKER_VERSIONS.go));
  const go = syntaxFragments(chunkSnapshot(snapshotOf('pkg/accounts.go', GO_MODULE)));
  assert.ok(go.every((fragment) => fragment.chunker === SYNTAX_CHUNKER_VERSIONS.go));
  const rust = syntaxFragments(chunkSnapshot(snapshotOf('src/point.rs', RUST_MODULE)));
  assert.ok(rust.every((fragment) => fragment.chunker === SYNTAX_CHUNKER_VERSIONS.rust));
});

test('Go boundaries cover declarations and function statements, with leading comments attached', () => {
  const outcome = parseTreeSitterBoundaries('go', GO_MODULE);
  assert.ok(outcome.ok);
  const top = outcome.boundaries.filter((b) => b.depth === 0).map((b) => [b.line, b.label]);
  assert.deepEqual(top, [[1, null], [3, null], [5, 'type:Account'], [9, 'method:Deposit'], [16, 'function:Describe']]);
  assert.deepEqual(outcome.boundaries.filter((b) => b.depth === 1 && b.line < 16).map((b) => b.line), [10, 13]);
});

test('Rust boundaries cover items, impl members and member statements, with doc comments attached', () => {
  const outcome = parseTreeSitterBoundaries('rust', RUST_MODULE);
  assert.ok(outcome.ok);
  const at = (depth: number): (string | number | null)[][] => outcome.boundaries
    .filter((b) => b.depth === depth).map((b) => [b.line, b.label]);
  assert.deepEqual(at(0), [[1, null], [3, 'struct:Point'], [6, 'impl:Point'], [16, 'impl:Point']]);
  assert.deepEqual(at(1), [[7, 'function:origin'], [10, 'function:norm'], [17, 'function:fmt']]);
  assert.deepEqual(at(2).map(([line]) => line), [8, 11, 12, 17]);
});

test('small Go and Rust files pack into exact fragments with structural labels', () => {
  for (const [path, text, label] of [
    ['pkg/accounts.go', GO_MODULE, /^method:Deposit$/], ['src/point.rs', RUST_MODULE, /Point$/],
  ] as const) {
    const snapshot = snapshotOf(path, text);
    const fragments = syntaxFragments(chunkSnapshot(snapshot, SMALL));
    assert.ok(fragments.length > 1, `${path} has several fragments`);
    assert.ok(fragments.some((fragment) => label.test(fragment.label ?? '')), `${path} labels ${String(label)}`);
    assertExact(snapshot, fragments);
  }
});

test('oversized Go and Rust functions are split inside their own ranges under the limits', () => {
  const goBody = Array.from({ length: 80 }, (_, n) => `\tvalue${String(n)} := compute(${String(n)})`).join('\n');
  const rustBody = Array.from({ length: 80 }, (_, n) => `    let value${String(n)} = compute(${String(n)});`).join('\n');
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  for (const [path, text] of [
    ['pkg/large.go', `package large\n\nfunc large() {\n${goBody}\n}\n`],
    ['src/large.rs', `fn large() {\n${rustBody}\n}\n`],
  ] as const) {
    const snapshot = snapshotOf(path, text);
    const fragments = syntaxFragments(chunkSnapshot(snapshot, limits));
    assert.ok(fragments.length > 1, `${path} is split`);
    for (const fragment of fragments) {
      assert.ok(fragment.tokenCount <= limits.maxTokens);
      assert.ok(fragment.byteCount <= limits.maxBytes);
    }
    assertExact(snapshot, fragments);
  }
});

test('windows cut from one oversized unit remember that unit as their declaration', () => {
  const literal = Array.from({ length: 80 }, (_, n) => `\t\t${String(n)},`).join('\n');
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  const snapshot = snapshotOf('pkg/literal.go', `package large\n\nfunc large() {\n\tvalues := []int{\n${literal}\n\t}\n\tuse(values)\n}\n`);
  const fragments = syntaxFragments(chunkSnapshot(snapshot, limits));
  const windows = fragments.filter((fragment) => fragment.declaration != null);
  assert.ok(windows.length > 1, 'the literal is cut into several windows');
  const declaration = windows[0]!.declaration!;
  assert.equal(declaration.startLine, windows[0]!.startLine);
  assert.equal(declaration.endLine, windows.at(-1)!.endLine);
  for (const window of windows) {
    assert.deepEqual(window.declaration, declaration);
    assert.ok(window.startLine >= declaration.startLine && window.endLine <= declaration.endLine);
  }
  for (const fragment of fragments) {
    if (fragment.declaration == null) assert.ok(fragment.endLine < declaration.startLine || fragment.startLine > declaration.endLine);
  }
  assertExact(snapshot, fragments);
});

test('BOM, CRLF and non-ASCII text keep exact offsets in Go and Rust', () => {
  for (const [path, text, label] of [
    ['pkg/café.go', '\uFEFFpackage café\r\n\r\n// état\r\nfunc Émoji() string {\r\n\treturn "😀"\r\n}\r\n', 'function:Émoji'],
    ['src/café.rs', '\uFEFF/// état\r\nfn émoji() -> &\'static str {\r\n    "😀"\r\n}\r\n', 'function:émoji'],
  ] as const) {
    const snapshot = snapshotOf(path, text);
    const fragments = syntaxFragments(chunkSnapshot(snapshot, SMALL));
    assertExact(snapshot, fragments);
    assert.ok(fragments.some((fragment) => fragment.label === label), path);
  }
});

test('malformed Go and Rust fall back to line windows with a reported reason', () => {
  for (const [path, text] of [
    ['pkg/broken.go', 'package broken\n\nfunc broken( {\n\treturn\n'],
    ['src/broken.rs', 'fn broken( {\n    let s = "unterminated;\n'],
  ] as const) {
    const snapshot = snapshotOf(path, text);
    const result = chunkSnapshot(snapshot);
    assert.ok(result.kind === 'fragments');
    assert.equal(result.strategy, 'line-window', path);
    assert.equal(result.fallback, 'parse_failure', path);
    assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), []);
  }
});

test('Go and Rust chunking is deterministic', () => {
  for (const [path, text] of [['pkg/accounts.go', GO_MODULE], ['src/point.rs', RUST_MODULE]] as const) {
    const snapshot = snapshotOf(path, text);
    const ids = (): string[] => syntaxFragments(chunkSnapshot(snapshot, SMALL)).map((f) => `${f.id}:${String(f.label)}`);
    assert.deepEqual(ids(), ids());
  }
});
