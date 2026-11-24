import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PreparedFragment } from '../src/source/chunker.ts';
import {
  LANGUAGE_CORPUS, emptyCounters, endsOnDetachedAttribute, gatesFor, heuristicDeclarations, labelledSymbol,
  languageGroupOf, measureDeclarations, startsMidBlock, summarize,
} from '../scripts/bench/languages.ts';

/** Structural metrics of `bench:languages` (spec 2.2 definitions) on minimal inputs. */

const group = (path: string) => {
  const found = languageGroupOf(path);
  assert.ok(found !== null);
  return found;
};

const fragment = (startLine: number, endLine: number, label: string | null, declaration?: [number, number]): PreparedFragment =>
  ({
    id: `f${String(startLine)}`, startLine, endLine, label, text: '',
    ...(declaration === undefined ? {} : { declaration: { startLine: declaration[0], endLine: declaration[1] } }),
  }) as unknown as PreparedFragment;

test('the corpus pins full commits and excludes parser stress fixtures', () => {
  assert.equal(LANGUAGE_CORPUS.length, 15);
  for (const repository of LANGUAGE_CORPUS) assert.match(repository.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(LANGUAGE_CORPUS.find((repository) => repository.name === 'sharkdp/bat')?.exclude, ['tests/syntax-tests/']);
  assert.equal(group('Polly/Policy.cs').id, 'csharp');
  assert.equal(group('src/a.mts').id, 'typescript');
  assert.equal(languageGroupOf('image.png'), null);
});

test('a fragment starts mid-block when its first line is deeper than its least-indented line', () => {
  assert.equal(startsMidBlock('    return x;\n  }\n\nfn next() {}\n'), true);
  assert.equal(startsMidBlock('\nfn next() {\n    1\n}\n'), false);
  assert.equal(startsMidBlock('\n\n'), false);
});

test('detached attributes are trailing attribute lines of a fragment that is not last', () => {
  const rust = group('a.rs');
  assert.equal(endsOnDetachedAttribute(rust, 'fn a() {}\n\n/// Doc\n#[derive(Debug)]\n', 10, 4), true);
  assert.equal(endsOnDetachedAttribute(rust, 'fn a() {}\n#[cfg(test)]\n', 2, 2), false);
  assert.equal(endsOnDetachedAttribute(rust, '#[derive(\n    Debug,\n)]\n', 10, 3), true);
  assert.equal(endsOnDetachedAttribute(rust, '#[derive(Debug)]\nstruct A;\n', 10, 2), false);
  const java = group('A.java');
  assert.equal(endsOnDetachedAttribute(java, '  }\n\n  @Override\n', 10, 3), true);
  assert.equal(endsOnDetachedAttribute(java, '  @Override public String toString() {\n', 10, 1), false);
  assert.equal(endsOnDetachedAttribute(group('a.go'), '// @Override\n', 10, 1), false);
});

test('brackets and newlines inside attribute strings do not extend the attribute', () => {
  const rust = group('a.rs');
  assert.equal(endsOnDetachedAttribute(rust, '#[should_panic(expected = "\\\n    a (b\\\n")]\nfn x() {}\n', 10, 4), false);
  assert.equal(endsOnDetachedAttribute(rust, '#[should_panic(expected = "\\\n    a (b\\\n")]\n', 10, 3), true);
  const python = group('a.py');
  assert.equal(endsOnDetachedAttribute(python, '@setup({"a": """\n{% ( [\n"""})\ndef f():\n    pass\n', 10, 5), false);
  assert.equal(endsOnDetachedAttribute(python, '@setup({"a": "{% (\\n"})\ndef f():\n    pass\n', 10, 3), false);
  assert.equal(endsOnDetachedAttribute(python, 'x = 1\n\n@setup({"a": """\n(\n"""})\n', 10, 5), true);
});

test('braces inside multi-line raw strings do not extend a Go function', () => {
  assert.deepEqual(
    heuristicDeclarations(group('a.go'), 'func A() {\n\ts := `x {\n\ty`\n}\n\nfunc B() {}\n')
      .map((declaration) => `${declaration.name}:${String(declaration.startLine)}-${String(declaration.endLine)}`),
    ['A:1-4', 'B:6-6'],
  );
});

test('heuristic declarations find names and extents per delimiting style', () => {
  assert.deepEqual(heuristicDeclarations(group('a.go'), 'package a\n\nfunc (s *S) Run() {\n\tgo func() {}()\n}\n\ntype S struct{}\n'), [
    { kind: 'method', name: 'Run', startLine: 3, endLine: 5 },
    { kind: 'struct', name: 'S', startLine: 7, endLine: 7 },
  ]);
  assert.deepEqual(heuristicDeclarations(group('a.py'), 'class A:\n    def run(self):\n        """x\ndef not_this():\n"""\n        return 1\n\ndef f():\n    pass\n'), [
    { kind: 'class', name: 'A', startLine: 1, endLine: 6 },
    { kind: 'method', name: 'run', startLine: 2, endLine: 6 },
    { kind: 'function', name: 'f', startLine: 8, endLine: 9 },
  ]);
  assert.deepEqual(heuristicDeclarations(group('a.rb'), 'class A\n  def run\n    1\n  end\nend\n'), [
    { kind: 'class', name: 'A', startLine: 1, endLine: 5 },
    { kind: 'method', name: 'run', startLine: 2, endLine: 4 },
  ]);
  assert.deepEqual(heuristicDeclarations(group('a.json'), '{"function": 1}\n'), []);
});

test('declaration metrics: hidden, split, back-reference and unlabelled continuations', () => {
  const counters = emptyCounters();
  const declarations = [
    { kind: 'function', name: 'big', startLine: 1, endLine: 30 },
    { kind: 'function', name: 'packed', startLine: 31, endLine: 32 },
  ] as const;
  measureDeclarations(declarations, [fragment(1, 15, 'function:big'), fragment(16, 30, null), fragment(31, 32, 'function:other')], counters);
  assert.equal(counters.declarations, 2);
  assert.equal(counters.declarationsHidden, 1);
  assert.equal(counters.splitCallables, 1);
  assert.equal(counters.splitCallablesWithDeclaration, 0);
  assert.equal(counters.continuations, 1);
  assert.equal(counters.continuationsUnlabelled, 1);

  const referenced = emptyCounters();
  measureDeclarations(declarations.slice(0, 1), [fragment(1, 15, 'function:big', [1, 30]), fragment(16, 30, 'function:big', [1, 30])], referenced);
  assert.equal(referenced.splitCallablesWithDeclaration, 1);
  assert.equal(referenced.continuationsUnlabelled, 0);
  assert.equal(labelledSymbol('method:Server.ServeHTTP'), 'ServeHTTP');
  assert.equal(labelledSymbol(null), null);
});

test('gates apply per language: full set when profiled, coverage and half mid-block otherwise', () => {
  const passing = { ...summarize(emptyCounters()), files: 1, profiled: true, midBlockShare: 0.1 };
  assert.ok(gatesFor('go', passing).every((gate) => gate.passed));
  const failing = gatesFor('rust', { ...passing, detachedAttributeFragments: 3, smallFragmentShare: 0.05 });
  assert.deepEqual(failing.filter((gate) => !gate.passed).map((gate) => gate.gate), ['detachedAttributeFragments', 'smallFragmentShare']);
  assert.equal(gatesFor('c', passing).at(-1)?.gate, 'parseFallbackLineShare');
  const windows = { ...passing, profiled: false, midBlockShare: 0.4 };
  assert.deepEqual(gatesFor('html', windows).map((gate) => gate.gate), ['uncoveredNonBlankLines']);
  assert.equal(gatesFor('html', windows, { ...windows, midBlockShare: 0.66 }).at(-1)?.passed, false);
  assert.equal(gatesFor('html', windows, { ...windows, midBlockShare: 0.9 }).at(-1)?.passed, true);
});

test('a C function returning a struct pointer is a function, not a struct', () => {
  assert.deepEqual(heuristicDeclarations(group('a.c'), 'struct node *make_node(int v) {\n  return 0;\n}\nstruct node {\n  int v;\n};\nstruct __attribute__ ((__packed__)) hdr8 {\n  int len;\n};\n')
    .map((declaration) => `${declaration.kind}:${declaration.name}`), ['function:make_node', 'struct:node', 'struct:hdr8']);
});

test('a rate just over a gate limit fails instead of rounding down to it', () => {
  const counters = { ...emptyCounters(), files: 1, syntaxFiles: 1, fragments: 100_000, midBlock: 15_001, splitCallables: 100_000, splitCallablesWithDeclaration: 99_999 };
  const failed = gatesFor('go', summarize(counters)).filter((gate) => !gate.passed).map((gate) => gate.gate);
  assert.ok(failed.includes('midBlockShare'));
  assert.ok(failed.includes('splitCallablesWithDeclarationShare'));
});
