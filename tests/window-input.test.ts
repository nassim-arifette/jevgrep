import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowInputOf, windowInputsOf } from '../src/source/window-input.ts';
import { lineWindows } from '../src/source/line-windows.ts';

/**
 * JG-012 integration seam: a prepared snapshot (JG-011, M) must reach the window chunker
 * without the chunker depending on the snapshot module. The adapter takes the small
 * structural view the chunker needs, so the two modules can be developed, reviewed and
 * replaced independently.
 *
 * The fake below deliberately mirrors the shape of M's SourceSnapshot class (relativePath,
 * text, sha256 as own properties) without importing it: a class instance must satisfy the
 * adapter exactly like a plain object.
 */
class FakeSnapshot {
  readonly relativePath: string;
  readonly text: string;
  readonly sha256: string;

  // Explicit fields rather than parameter properties: `erasableSyntaxOnly` forbids syntax
  // that Node's strip-only mode cannot run.
  constructor(relativePath: string, text: string, sha256: string) {
    this.relativePath = relativePath;
    this.text = text;
    this.sha256 = sha256;
  }
}

test('a prepared snapshot maps onto the chunker input unchanged', () => {
  const snapshot = new FakeSnapshot('src/app.ts', 'const a = 1;\nconst b = 2;\n', 'b'.repeat(64));
  const input = windowInputOf(snapshot);

  assert.deepEqual(input, { path: 'src/app.ts', text: snapshot.text, sha256: snapshot.sha256 });
  assert.equal(input.text, snapshot.text, 'the text must not be copied, re-encoded or trimmed');
  assert.equal(input.sha256, snapshot.sha256);
});

test('windows produced through the adapter are exact slices of the snapshot text', () => {
  const text = 'const city = "Orléans"; // café ☕\n\nconst after = 1;\nconst tail = 2;\n';
  const snapshot = new FakeSnapshot('src/unicode.ts', text, 'c'.repeat(64));
  const result = lineWindows(windowInputOf(snapshot));

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  const bytes = Buffer.from(text, 'utf8');
  const covered = new Set<number>();
  for (const window of result.windows) {
    for (let line = window.startLine; line <= window.endLine; line += 1) {
      covered.add(line);
    }
    assert.equal(window.path, 'src/unicode.ts');
    assert.equal(window.sha256, snapshot.sha256);
    assert.equal(window.text, bytes.subarray(window.byteStart, window.byteEnd).toString('utf8'));
  }
  for (const line of [1, 3, 4]) {
    assert.ok(covered.has(line), `line ${String(line)} is not covered`);
  }
});

test('a BOM and CRLF survive the adapter', () => {
  const text = '\uFEFFfirst\r\nsecond\r\n';
  const input = windowInputOf(new FakeSnapshot('config/default.json', text, 'd'.repeat(64)));
  assert.equal(input.text.startsWith('\uFEFF'), true);

  const result = lineWindows(input);
  assert.equal(result.kind, 'windows');
  if (result.kind === 'windows') {
    const joined = result.windows.map((window) => window.text).join('');
    assert.equal(joined.includes('\r\n'), true);
    assert.equal(Buffer.from(joined, 'utf8').equals(Buffer.from(text, 'utf8')), true);
  }
});

test('paths are normalised to POSIX separators for identifiers and requests', () => {
  const input = windowInputOf(new FakeSnapshot('src\\routes\\orders.ts', 'const a = 1;\n', 'e'.repeat(64)));
  assert.equal(input.path, 'src/routes/orders.ts');
  const result = lineWindows(input);
  if (result.kind === 'windows') {
    assert.equal(result.windows[0]?.id.startsWith('src/routes/orders.ts#'), true);
  }
});

test('a malformed snapshot is refused loudly instead of producing silent evidence', () => {
  const valid = { relativePath: 'src/a.ts', text: 'x', sha256: 'f'.repeat(64) };
  assert.throws(() => windowInputOf({ ...valid, relativePath: '' }), /relativePath/);
  assert.throws(() => windowInputOf({ ...valid, sha256: '' }), /sha256/);
  assert.throws(() => windowInputOf({ ...valid, text: undefined as unknown as string }), /text/);
  assert.throws(() => windowInputOf({ ...valid, relativePath: '/abs/path.ts' }), /absolute/i);
});

test('a list of snapshots maps in order, and the result is deterministic', () => {
  const snapshots = [
    new FakeSnapshot('src/a.ts', 'const a = 1;\n', '1'.repeat(64)),
    new FakeSnapshot('src/b.ts', 'const b = 2;\n', '2'.repeat(64)),
  ];
  const first = windowInputsOf(snapshots);
  const second = windowInputsOf(snapshots);

  assert.deepEqual(first.map((input) => input.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(first, second);
  assert.equal(first[1]?.sha256, '2'.repeat(64));
});
