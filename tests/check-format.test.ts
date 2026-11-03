import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProblems, isCheckedPath } from '../scripts/check-format.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const rules = (path: string, text: string): string[] => formatProblems(path, bytes(text)).map((problem) => problem.rule);

test('a file following .editorconfig has no problems', () => {
  assert.deepEqual(rules('src/a.ts', 'const a = 1;\n  indented();\n'), []);
  assert.deepEqual(formatProblems('empty.txt', new Uint8Array()), []);
});

test('each editorconfig rule is reported with its first offending line', () => {
  assert.deepEqual(formatProblems('src/a.ts', bytes('ok\nbad \nalso bad\t\n')), [{ path: 'src/a.ts', line: 2, rule: 'trailing whitespace' }]);
  assert.deepEqual(rules('src/a.ts', 'a\r\nb\r\n'), ['CRLF line ending']);
  assert.deepEqual(rules('src/a.ts', 'a\nb'), ['missing final newline']);
  assert.deepEqual(rules('src/a.ts', 'a\n\tb\n'), ['tab indentation']);
  assert.deepEqual(formatProblems('x.json', Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a])), [{ path: 'x.json', line: null, rule: 'not valid UTF-8' }]);
});

test('Markdown keeps trailing spaces, binaries and minified vendor code are skipped', () => {
  assert.deepEqual(rules('README.md', 'line break  \nnext\n'), []);
  assert.equal(isCheckedPath('docs/assets/demo.gif'), false);
  assert.equal(isCheckedPath('demo/video/assets/gsap.min.js'), false);
  assert.equal(isCheckedPath('src/engine.ts'), true);
  assert.equal(isCheckedPath('.editorconfig'), true);
});
