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
  assert.deepEqual(top, [[1, null], [3, null], [5, 'type:Account'], [9, 'method:Account.Deposit'], [16, 'function:Describe']]);
  assert.deepEqual(outcome.boundaries.filter((b) => b.depth === 1 && b.line < 16).map((b) => b.line), [10, 13]);
});

test('Rust boundaries cover items, impl members and member statements, with doc comments attached', () => {
  const outcome = parseTreeSitterBoundaries('rust', RUST_MODULE);
  assert.ok(outcome.ok);
  const at = (depth: number): (string | number | null)[][] => outcome.boundaries
    .filter((b) => b.depth === depth).map((b) => [b.line, b.label]);
  assert.deepEqual(at(0), [[1, null], [3, 'struct:Point'], [6, 'impl:Point'], [16, 'impl:Display for Point']]);
  assert.deepEqual(at(1), [[7, 'function:origin'], [10, 'function:norm'], [17, 'function:fmt']]);
  assert.deepEqual(at(2).map(([line]) => line), [8, 11, 12, 17]);
});

const labelsAt = (language: 'go' | 'rust', text: string, depth = 0): (string | number | null)[][] => {
  const outcome = parseTreeSitterBoundaries(language, text);
  assert.ok(outcome.ok);
  return outcome.boundaries.filter((b) => b.depth === depth).map((b) => [b.line, b.label]);
};

test('Rust attributes attach to the next item with the doc comments above them', () => {
  const text = `#![allow(dead_code)]
use std::fmt;

fn before() {}
/// A configuration.
#[derive(Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config;

#[cfg(test)]

// Unit tests.
mod tests {
    #[test]
    fn works() {}
}
`;
  assert.deepEqual(labelsAt('rust', text), [[1, null], [4, 'function:before'], [5, 'struct:Config'], [10, 'mod:tests']]);
  assert.deepEqual(labelsAt('rust', text, 1), [[14, 'function:works']]);
  const snapshot = snapshotOf('src/config.rs', text);
  const fragments = syntaxFragments(chunkSnapshot(snapshot, { ...DEFAULT_WINDOW_LIMITS, targetTokens: 1, maxTokens: 400 }));
  for (const fragment of fragments) {
    assert.doesNotMatch(fragment.text.trimEnd().split('\n').at(-1)!, /^\s*#!?\[/, `${fragment.id} ends on an attribute`);
  }
  assertExact(snapshot, fragments);
});

test('Rust labels name trait impls, constants, statics, unions and item macros', () => {
  const text = `impl fmt::Display for Config {}
impl<T> From<T> for crate::Wrapper<T> {}
impl config::Config {}
const LIMIT: usize = 8;
static NAME: &str = "jevgrep";
union Bits { i: u32, f: f32 }
macro_rules! square { ($x:expr) => { $x * $x }; }
lazy_static! { static ref CACHE: u8 = 0; }
std::thread_local! { static DEPTH: u8 = 0; }
fn main() { println!("{}", square!(2)); }
`;
  assert.deepEqual(labelsAt('rust', text), [
    [1, 'impl:Display for Config'], [2, 'impl:From<T> for Wrapper<T>'], [3, 'impl:Config'], [4, 'const:LIMIT'],
    [5, 'static:NAME'], [6, 'union:Bits'], [7, 'macro:square'], [8, 'macro:lazy_static'], [9, 'macro:thread_local'],
    [10, 'function:main'],
  ]);
  assert.deepEqual(labelsAt('rust', text, 1).map(([, label]) => label), [null]);
});

test('Go methods carry their receiver type, and const and var declarations their first name', () => {
  const text = `package server

const A, B = 1, 2
const (
\tC = iota
\tD
)
var (
\tdefaultServer = &Server{}
)
func (s *Server) ServeHTTP() {}
func (c *Client) ServeHTTP() {}
func (l List[T]) Len() int { return 0 }
func (*Tree[K, V]) Walk() {}
func (Value) String() string { return "" }
`;
  assert.deepEqual(labelsAt('go', text), [
    [1, null], [3, 'const:A'], [4, 'const:C'], [8, 'var:defaultServer'], [11, 'method:Server.ServeHTTP'],
    [12, 'method:Client.ServeHTTP'], [13, 'method:List.Len'], [14, 'method:Tree.Walk'], [15, 'method:Value.String'],
  ]);
});

test('oversized Go function literals held by var, go and defer are split along their statements', () => {
  const body = (indent: string): string => Array.from({ length: 60 }, (_, n) => `${indent}value${String(n)} := compute(${String(n)})`).join('\n');
  const text = `package large

var handler = func() {
${body('\t')}
}

func serve() {
\tgo func() {
${body('\t\t')}
\t}()
\tdefer func() {
${body('\t\t')}
\t}()
}
`;
  const outcome = parseTreeSitterBoundaries('go', text);
  assert.ok(outcome.ok);
  const lines = (depth: number): number[] => outcome.boundaries.filter((b) => b.depth === depth).map((b) => b.line);
  assert.deepEqual(lines(0), [1, 3, 66]);
  assert.equal(lines(1).filter((line) => line > 3 && line < 66).length, 60);
  assert.deepEqual(lines(1).filter((line) => line > 66), [67, 129]);
  assert.equal(lines(2).length, 120);
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  const snapshot = snapshotOf('pkg/large.go', text);
  const fragments = syntaxFragments(chunkSnapshot(snapshot, limits));
  const starts = new Set([1, ...outcome.boundaries.map((boundary) => boundary.line)]);
  assert.ok(fragments.every((fragment) => starts.has(fragment.startLine)), 'no line windows were needed');
  assertExact(snapshot, fragments);
});

test('a comment opening a Go block does not hide the statements after it', () => {
  const text = 'package x\n\nfunc f() {\n\t// Setup.\n\ta()\n\tb()\n}\n';
  assert.deepEqual(labelsAt('go', text, 1).map(([line]) => line), [4, 6]);
});

test('a function literal alone in a grouped Go var declaration is refined like a top-level one', () => {
  const text = 'package x\n\nvar (\n\thandler = func() {\n\t\ta()\n\t\tb()\n\t}\n)\n';
  assert.deepEqual(labelsAt('go', text), [[1, null], [3, 'var:handler']]);
  assert.deepEqual(labelsAt('go', text, 1).map(([line]) => line), [5, 6]);
});

test('small Go and Rust files pack into exact fragments with structural labels', () => {
  for (const [path, text, label] of [
    ['pkg/accounts.go', GO_MODULE, /^method:Account\.Deposit$/], ['src/point.rs', RUST_MODULE, /Point$/],
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

test('every fragment cut from a Go or Rust function along its statements records the whole function (D1)', () => {
  const goBody = Array.from({ length: 80 }, (_, n) => `\tvalue${String(n)} := compute(${String(n)})`).join('\n');
  const rustBody = Array.from({ length: 80 }, (_, n) => `    let value${String(n)} = compute(${String(n)});`).join('\n');
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  for (const [path, text, declaration] of [
    ['pkg/large.go', `package large\n\nfunc large() {\n${goBody}\n}\n`, { startLine: 3, endLine: 84 }],
    ['src/large.rs', `fn large() {\n${rustBody}\n}\n`, { startLine: 1, endLine: 82 }],
  ] as const) {
    const fragments = syntaxFragments(chunkSnapshot(snapshotOf(path, text), limits));
    const inside = fragments.filter((f) => f.startLine >= declaration.startLine);
    assert.ok(inside.length > 1, `${path} is split along its statements`);
    for (const fragment of inside) {
      assert.deepEqual(fragment.declaration, declaration, `${path}:${String(fragment.startLine)}`);
    }
  }
});

test('a Rust continuation is not labelled with a nested function it happens to contain (D7)', () => {
  const lines = (prefix: string, count: number): string =>
    Array.from({ length: count }, (_, n) => `    let ${prefix}${String(n)} = compute(${String(n)});`).join('\n');
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 60, maxTokens: 120, maxBytes: 900 };
  const text = `fn long() {\n${lines('a', 8)}\n    fn helper() -> i32 {\n        1\n    }\n${lines('b', 12)}\n}\n`;
  const fragments = syntaxFragments(chunkSnapshot(snapshotOf('src/long.rs', text), limits));
  const containing = fragments.find((f) => f.text.includes('fn helper'))!;
  assert.ok(!containing.text.trimStart().startsWith('fn helper'), 'the nested function is inside a continuation');
  assert.equal(containing.label, null);
  assert.ok(fragments.every((f) => f.label !== 'function:helper'));
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
