import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countReferenceTokens } from '../src/response/token-counter.ts';
import {
  chunkSnapshot, SYNTAX_CHUNKER_VERSIONS, syntaxLanguageOf, uncoveredNonBlankLines, usesSyntaxChunking,
} from '../src/source/chunker.ts';
import type { ChunkResult, PreparedFragment } from '../src/source/chunker.ts';
import { parseJavaBoundaries } from '../src/source/java-boundaries.ts';
import { DEFAULT_WINDOW_LIMITS } from '../src/source/line-windows.ts';
import { parsePythonBoundaries } from '../src/source/python-boundaries.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import type { SourceSnapshot } from '../src/source/snapshot.ts';

/**
 * Python and Java syntax chunking (JG-015): boundaries come from lexical scanners,
 * fragments stay exact snapshot slices covering every non-blank line, and a file the
 * scanner refuses falls back to line windows with a reported reason.
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
    const slice = snapshot.sliceLines(fragment.startLine, fragment.endLine);
    assert.equal(fragment.text, slice.text);
    assert.equal(fragment.byteStart, slice.startByte);
    assert.equal(fragment.byteEnd, slice.endByte);
    assert.equal(fragment.byteCount, Buffer.byteLength(fragment.text));
  }
  assert.deepEqual(uncoveredNonBlankLines(snapshot, fragments), []);
}

function lineOf(text: string): (offset: number) => number {
  return (offset) => text.slice(0, offset).split('\n').length;
}

const SMALL = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 20, maxTokens: 400 };

const PYTHON_MODULE = `"""Account helpers."""
import os
from typing import (
    Any,
)

# Stores an account.
@dataclass
@frozen
class Account:
    """Doc."""
    name: str = 'x'  # trailing

    def login(self, password):
        if password:
            return f"{self.name}"
        return None

    async def logout(self):
        text = """multi
line with def fake():"""
        return text \\
            + "x"

def helper(a,
           b):
    return a + b
`;

const JAVA_MODULE = `package com.example;

import java.util.List;

/**
 * Service doc.
 */
@Service
public class AccountService {
    private final int[] values = {1, 2, 3};
    private static final String TEXT = """
        void fake() { ; }
        """;

    // Creates it.
    @Override
    public AccountService(int x) {
        this.x = x;
    }

    public <T> List<String> names() {
        if (a) {
            b();
        } else {
            c();
        }
        do {
            x++;
        } while (x < 3);
        list.forEach(item -> {
            use(item);
        });
        return List.of();
    }
}

interface Other {
    void call();
}
`;

test('Python and Java extensions select their own syntax chunker version', () => {
  assert.equal(syntaxLanguageOf('src/app.py'), 'python');
  assert.equal(syntaxLanguageOf('src/stubs.PYI'), 'python');
  assert.equal(syntaxLanguageOf('src/Main.java'), 'java');
  assert.equal(syntaxLanguageOf('src/Main.kt'), null);
  assert.equal(usesSyntaxChunking('src/Main.java'), true);

  const python = syntaxFragments(chunkSnapshot(snapshotOf('src/app.py', PYTHON_MODULE)));
  assert.ok(python.every((fragment) => fragment.chunker === SYNTAX_CHUNKER_VERSIONS.python));
  const java = syntaxFragments(chunkSnapshot(snapshotOf('src/Main.java', JAVA_MODULE)));
  assert.ok(java.every((fragment) => fragment.chunker === SYNTAX_CHUNKER_VERSIONS.java));
  assert.notEqual(SYNTAX_CHUNKER_VERSIONS.python, SYNTAX_CHUNKER_VERSIONS.javascript);
});

test('Python boundaries follow logical lines, indentation, decorators and comments', () => {
  const outcome = parsePythonBoundaries(PYTHON_MODULE, lineOf(PYTHON_MODULE));
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.boundaries.filter((boundary) => boundary.depth <= 1).map(({ line, depth, label }) => [line, depth, label]),
    [
      [1, 0, null], [2, 0, null], [3, 0, null],
      [7, 0, 'class:Account'], [11, 1, null], [12, 1, null],
      [14, 1, 'method:login'], [19, 1, 'method:logout'],
      [25, 0, 'function:helper'], [27, 1, null],
    ],
  );
});

test('Java boundaries cover declarations, members and statements, not literals or continuations', () => {
  const outcome = parseJavaBoundaries(JAVA_MODULE, lineOf(JAVA_MODULE));
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.boundaries.map(({ line, depth, label }) => [line, depth, label]),
    [
      [1, 0, null], [3, 0, null], [5, 0, 'class:AccountService'],
      [10, 1, null], [11, 1, null],
      [15, 1, 'method:AccountService'], [18, 2, null],
      [21, 1, 'method:names'], [22, 2, null], [27, 2, null], [30, 2, null], [33, 2, null],
      [37, 0, 'interface:Other'], [38, 1, 'method:call'],
    ],
  );
});

test('documentation stays attached to the Python and Java declarations it precedes', () => {
  const members = { ...SMALL, maxTokens: 60 };
  const python = syntaxFragments(chunkSnapshot(snapshotOf('src/app.py', PYTHON_MODULE), members));
  assert.ok(python.some((f) => f.text.includes('# Stores an account.\n@dataclass\n@frozen\nclass Account:')));
  assert.ok(python.some((f) => f.label === 'method:login' && f.text.trimStart().startsWith('def login')));

  const java = syntaxFragments(chunkSnapshot(snapshotOf('src/Main.java', JAVA_MODULE), members));
  assert.ok(java.some((f) => f.label === 'method:names' && f.text.trimStart().startsWith('public <T>')));
  assert.ok(java.some((f) => f.text.includes('    // Creates it.\n    @Override\n    public AccountService(')));
});

test('oversized Python and Java declarations are split inside their own ranges under the limits', () => {
  const pyBody = Array.from({ length: 80 }, (_, n) => `    value${String(n)} = compute(${String(n)})`).join('\n');
  const javaBody = Array.from({ length: 80 }, (_, n) => `        int value${String(n)} = compute(${String(n)});`).join('\n');
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetTokens: 90, maxTokens: 150, maxBytes: 900 };
  for (const [path, text] of [
    ['src/large.py', `def large():\n${pyBody}\n\ntail = 1\n`],
    ['src/Large.java', `class Large {\n    void large() {\n${javaBody}\n    }\n}\n`],
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

test('BOM, CRLF and non-ASCII text keep exact offsets in Python and Java', () => {
  const python = '\uFEFF# état\r\nclass Café:\r\n    def méthode(self):\r\n        return "😀"\r\n\r\nvaleur = 1\r\n';
  const pySnapshot = snapshotOf('src/café.py', python);
  const pyFragments = syntaxFragments(chunkSnapshot(pySnapshot, SMALL));
  assertExact(pySnapshot, pyFragments);
  assert.ok(pyFragments.some((f) => f.label === 'class:Café'));

  const java = '\uFEFF/** état */\r\npublic class Café {\r\n    String emoji() { return "😀"; }\r\n}\r\n';
  const javaSnapshot = snapshotOf('src/Café.java', java);
  const javaFragments = syntaxFragments(chunkSnapshot(javaSnapshot, SMALL));
  assertExact(javaSnapshot, javaFragments);
  assert.ok(javaFragments.some((f) => f.text.includes('/** état */\r\npublic class Café {')));
});

test('malformed Python and Java fall back to line windows with a reported reason', () => {
  for (const [path, text] of [
    ['src/broken.py', 'def broken(:\n    value = "unterminated\n'],
    ['src/indent.py', 'def ok():\n    return 1\n  stray = 2\n'],
    ['src/body.py', 'class Empty:\nvalue = 1\n'],
    ['src/Broken.java', 'class Broken {\n    void run() {\n        String s = "oops;\n'],
    ['src/Unclosed.java', 'class Unclosed {\n    /* never closed\n}\n'],
  ] as const) {
    const snapshot = snapshotOf(path, text);
    const result = chunkSnapshot(snapshot);
    assert.ok(result.kind === 'fragments');
    assert.equal(result.strategy, 'line-window', path);
    assert.equal(result.fallback, 'parse_failure', path);
    assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), []);
  }
});

test('Python and Java chunking is deterministic', () => {
  for (const [path, text] of [['src/app.py', PYTHON_MODULE], ['src/Main.java', JAVA_MODULE]] as const) {
    const snapshot = snapshotOf(path, text);
    const ids = (): string[] => syntaxFragments(chunkSnapshot(snapshot, SMALL)).map((f) => `${f.id}:${String(f.label)}`);
    assert.deepEqual(ids(), ids());
  }
});

test('Java documentation after a closing brace belongs to the next member, not the previous one', () => {
  const text = 'class Docs {\n    void first() {\n        run();\n    } // trailing\n\n    /** Second. */\n    @Deprecated\n    void second() {\n    }\n}\n';
  const outcome = parseJavaBoundaries(text, lineOf(text));
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.boundaries.filter((boundary) => boundary.depth === 1).map(({ line, label }) => [line, label]),
    [[2, 'method:first'], [6, 'method:second']],
  );
});
