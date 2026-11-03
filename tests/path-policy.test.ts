import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelativePath } from '../src/path-policy.ts';
import { UnauthorizedPathError, assertSafeRelativePath } from '../src/source/authorization.ts';

test('relative paths normalize to a canonical slash form', () => {
  assert.deepEqual(checkRelativePath('src\\source//./x.ts'), { ok: true, normalized: 'src/source/x.ts' });
  assert.deepEqual(checkRelativePath('.'), { ok: true, normalized: '.' });
  assert.deepEqual(checkRelativePath('./'), { ok: true, normalized: '.' });
});

test('each violation is reported in a stable order', () => {
  const cases: [string, string][] = [
    ['/etc', 'absolute'], ['\\\\server\\share', 'absolute'], ['/a<b', 'absolute'],
    ['a<b', 'syntax'], ['C:/x', 'syntax'], ['a\u0000b', 'syntax'],
    ['a/../b', 'traversal'], ['..\\x', 'traversal'], ['x./../y', 'traversal'],
    ['dir./file', 'trailing'], ['file ', 'trailing'],
    ['nul', 'device'], ['src/COM1.txt', 'device'], ['lpt¹', 'device'],
  ];
  for (const [input, violation] of cases) {
    assert.deepEqual(checkRelativePath(input), { ok: false, violation }, input);
  }
});

test('source authorization applies the same lexical policy', () => {
  for (const input of ['src/x.ts', 'a\\b', './c', '/etc', 'a/../b', 'dir./f', 'aux.ts', 'a|b']) {
    const checked = checkRelativePath(input);
    if (checked.ok) {
      assert.equal(assertSafeRelativePath(input), checked.normalized, input);
    } else {
      assert.throws(() => assertSafeRelativePath(input), UnauthorizedPathError, input);
    }
  }
  assert.throws(() => assertSafeRelativePath(''), UnauthorizedPathError, 'an empty path is never authorized');
});
