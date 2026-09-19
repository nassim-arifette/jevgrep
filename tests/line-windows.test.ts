import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_LIMITS,
  LINE_WINDOW_CHUNKER_VERSION,
  lineWindows,
  type FragmentWindow,
  type SnapshotText,
  type WindowLimits,
} from '../src/source/line-windows.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';

/**
 * JG-012 - line-window chunking (specification 5.4, requirements R3 and R4).
 *
 * The seam is a pure function over one prepared snapshot: text in, windows out. No file
 * system, no scheduling, no provider - the same properties the plan asks the chunker to
 * hide behind `fragment(snapshot)`.
 */
function snapshot(text: string, path = 'src/example.ts'): SnapshotText {
  return { path, text, sha256: 'a'.repeat(64) };
}

const utf8 = (value: string): Buffer => Buffer.from(value, 'utf8');

function nonblankLines(text: string): number[] {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.replace(/\r$/, ''), index: index + 1 }))
    .filter((entry) => entry.line.trim().length > 0)
    .map((entry) => entry.index);
}

function coveredLines(windows: readonly FragmentWindow[]): Set<number> {
  const covered = new Set<number>();
  for (const window of windows) {
    for (let line = window.startLine; line <= window.endLine; line += 1) {
      covered.add(line);
    }
  }
  return covered;
}

function longSource(lineCount: number, blankEvery = 7): string {
  const lines: string[] = [];
  for (let index = 1; index <= lineCount; index += 1) {
    lines.push(index % blankEvery === 0 ? '' : `export const value${String(index)} = ${String(index)}; // line ${String(index)}`);
  }
  return `${lines.join('\n')}\n`;
}

test('every nonblank line of a prepared file is covered by at least one window', () => {
  const text = longSource(300);
  const result = lineWindows(snapshot(text));

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  const covered = coveredLines(result.windows);
  for (const line of nonblankLines(text)) {
    assert.ok(covered.has(line), `line ${String(line)} is not covered`);
  }
  assert.deepEqual(
    result.windows.map((window) => window.path),
    result.windows.map(() => 'src/example.ts'),
  );
});

test('a window respects the active limits without truncating a line or a character', () => {
  const text = longSource(300);
  const limits: WindowLimits = { ...DEFAULT_WINDOW_LIMITS, targetLines: 8, maxLines: 12, maxBytes: 512, targetTokens: 60, maxTokens: 120 };
  const result = lineWindows(snapshot(text), limits);

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  assert.ok(result.windows.length > 1, 'the file must be split');
  for (const window of result.windows) {
    const lineCount = window.endLine - window.startLine + 1;
    assert.ok(lineCount <= limits.maxLines, `window has ${String(lineCount)} lines`);
    assert.ok(window.byteCount <= limits.maxBytes, `window has ${String(window.byteCount)} bytes`);
    assert.ok(window.tokenCount <= limits.maxTokens, `window has ${String(window.tokenCount)} tokens`);
    assert.ok(window.tokenCount > 0);
    // The text is an exact original slice: byte offsets and text agree, and no line is cut.
    const slice = utf8(text).subarray(window.byteStart, window.byteEnd).toString('utf8');
    assert.equal(window.text, slice);
    assert.ok(window.text.endsWith('\n') || window.endLine === text.split('\n').length - 1);
    assert.equal(window.text.includes('\uFFFD'), false, 'no replacement character may appear');
  }
});

test('windows carry exact UTF-8 byte offsets for multi-byte source', () => {
  const text = 'const city = "Orléans"; // café ☕\nconst emoji = "🎯";\nconst after = 1;\n';
  const result = lineWindows(snapshot(text, 'src/unicode.ts'));

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  for (const window of result.windows) {
    const bytes = utf8(text);
    assert.equal(bytes.subarray(window.byteStart, window.byteEnd).toString('utf8'), window.text);
    assert.equal(window.byteCount, utf8(window.text).length);
  }
  assert.equal(result.windows[0]?.startLine, 1);
  assert.equal(result.windows[0]?.byteStart, 0);
});

test('overlapping windows are bounded, share identical text and always progress', () => {
  const text = longSource(200);
  const limits: WindowLimits = { ...DEFAULT_WINDOW_LIMITS, targetLines: 10, maxLines: 10, overlapLines: 3, maxBytes: 4096, maxTokens: 400 };
  const result = lineWindows(snapshot(text), limits);

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  const bytes = utf8(text);
  for (let index = 1; index < result.windows.length; index += 1) {
    const previous = result.windows[index - 1];
    const current = result.windows[index];
    assert.ok(previous !== undefined);
    assert.ok(current !== undefined);
    assert.ok(current.startLine > previous.startLine, 'windows must progress');
    assert.ok(current.byteStart >= previous.byteStart);

    const overlapLines = previous.endLine - current.startLine + 1;
    if (overlapLines > 0) {
      assert.ok(overlapLines <= limits.overlapLines, `overlap of ${String(overlapLines)} lines exceeds the bound`);
      // The shared lines are the same original bytes in both windows, not a copied or
      // re-generated copy: the overlap is an original contiguous slice.
      const overlapText: string = bytes.subarray(current.byteStart, previous.byteEnd).toString('utf8');
      assert.ok(overlapText.length > 0);
      assert.ok(previous.text.endsWith(overlapText), 'the previous window ends with the shared lines');
      assert.ok(current.text.startsWith(overlapText), 'the current window starts with the same lines');
    }
  }
});

test('the same snapshot and limits produce the same windows in the same order', () => {
  const text = longSource(180);
  const first = lineWindows(snapshot(text), { ...DEFAULT_WINDOW_LIMITS, maxLines: 15, targetLines: 12 });
  const second = lineWindows(snapshot(text), { ...DEFAULT_WINDOW_LIMITS, maxLines: 15, targetLines: 12 });

  assert.deepEqual(first, second);
  if (first.kind === 'windows') {
    const ids = first.windows.map((window) => window.id);
    assert.equal(new Set(ids).size, ids.length, 'window identifiers must be unique');
    assert.deepEqual(
      first.windows.map((window) => window.startLine),
      [...first.windows.map((window) => window.startLine)].sort((left, right) => left - right),
    );
  }
});

test('a single line no legal window can hold is reported instead of truncated', () => {
  const text = `const ok = 1;\nconst minified = "${'x'.repeat(20_000)}";\nconst after = 2;\n`;
  const result = lineWindows(snapshot(text, 'src/minified.js'));

  assert.equal(result.kind, 'unsupported-long-line');
  if (result.kind !== 'unsupported-long-line') {
    return;
  }
  assert.equal(result.line, 2);
  assert.ok(result.byteCount > DEFAULT_WINDOW_LIMITS.maxBytes);
  assert.ok(result.reason.length > 0);
});

test('a blank-only file produces no window and no long-line report', () => {
  const result = lineWindows(snapshot('\n\n   \n\t\n'));
  assert.deepEqual(result, { kind: 'windows', windows: [] });
});

test('line endings are preserved exactly and CRLF counts as one ending', () => {
  const text = 'first\r\nsecond\r\n\r\nthird\r\n';
  const result = lineWindows(snapshot(text, 'config/default.json'));

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  const joined = result.windows.map((window) => window.text).join('');
  assert.ok(joined.includes('\r\n'), 'CRLF must survive chunking');
  assert.equal(result.windows.every((window) => !window.text.includes('\n\n\r')), true);
  const last = result.windows[result.windows.length - 1];
  assert.ok(last !== undefined);
  assert.equal(last.endLine, 4, 'a terminal newline does not invent a fifth line');
  assert.equal(nonblankLines(text).includes(last.endLine), true);
});

test('windows carry the metadata the specification requires', () => {
  const text = longSource(24);
  const result = lineWindows(snapshot(text, 'migrations/0001.sql'));

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  const window = result.windows[0];
  assert.ok(window !== undefined);
  assert.equal(window.path, 'migrations/0001.sql');
  assert.equal(window.sha256, 'a'.repeat(64));
  assert.equal(window.chunker, LINE_WINDOW_CHUNKER_VERSION);
  assert.equal(window.classification, 'line-window');
  assert.equal(window.startLine, 1);
  assert.equal(window.byteStart, 0);
  assert.equal(window.byteEnd, window.byteStart + window.byteCount);
  assert.equal(window.tokenCount, countReferenceTokens(window.text));
  assert.equal(window.id.includes(window.path), true);
});

test('the default limits follow the specification values', () => {
  assert.deepEqual(DEFAULT_WINDOW_LIMITS, {
    targetTokens: 800,
    maxTokens: 1_600,
    maxBytes: 8 * 1_024,
    targetLines: 80,
    maxLines: 120,
    overlapLines: 8,
  });
  // The pinned counter is local and offline: no dependency and no network on this path.
  assert.equal(process.env['JEVG_API_KEY'], undefined);
});

test('soft line and token targets shape windows before the hard maxima', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}\n`).join('');
  const byLines = lineWindows(snapshot(text), {
    ...DEFAULT_WINDOW_LIMITS,
    targetLines: 3,
    maxLines: 10,
    overlapLines: 0,
  }, () => 1);
  assert.equal(byLines.kind, 'windows');
  if (byLines.kind === 'windows') {
    assert.deepEqual(byLines.windows.map((window) => [window.startLine, window.endLine]), [
      [1, 3], [4, 6], [7, 9], [10, 10],
    ]);
  }

  const byTokens = lineWindows(snapshot(text), {
    ...DEFAULT_WINDOW_LIMITS,
    targetTokens: 2,
    maxTokens: 100,
    targetLines: 10,
    maxLines: 10,
    overlapLines: 0,
  }, (value) => value.split('\n').filter(Boolean).length);
  assert.equal(byTokens.kind, 'windows');
  if (byTokens.kind === 'windows') {
    assert.deepEqual(byTokens.windows.map((window) => [window.startLine, window.endLine]), [
      [1, 2], [3, 4], [5, 6], [7, 8], [9, 10],
    ]);
  }
});

test('the injected counter controls single-line refusal and target validation', () => {
  const refused = lineWindows(snapshot('short\n'), {
    ...DEFAULT_WINDOW_LIMITS,
    targetTokens: 25,
    maxTokens: 50,
  }, () => 51);
  assert.deepEqual(refused, {
    kind: 'unsupported-long-line',
    line: 1,
    reason: 'unsupported_long_line',
    byteCount: 6,
    tokenCount: 51,
  });

  assert.throws(() => lineWindows(snapshot('x'), {
    ...DEFAULT_WINDOW_LIMITS,
    targetLines: 0,
  }), /targets and limits must be positive/);
});

test('the window invariants hold across limit profiles and source shapes', () => {
  // Deterministic sweep (no randomness): every profile must satisfy the same invariants on
  // every source shape, so a limit interaction cannot regress silently.
  const sources: readonly (readonly [string, string])[] = [
    ['lf', longSource(260)],
    ['crlf', longSource(120).replace(/\n/g, '\r\n')],
    ['unicode', `${Array.from({ length: 90 }, (_, index) => `const cafe${String(index)} = "Orleans ${String(index)}"; // accent: \u00e9 \u2603`).join('\n')}\n`],
    ['blank-heavy', `${Array.from({ length: 140 }, (_, index) => (index % 3 === 0 ? `value ${String(index)}` : '')).join('\n')}\n`],
    ['no-final-newline', 'const a = 1;\nconst b = 2;'],
    // Long word-like lines: 220 bytes for ~55 reference tokens, so the byte limit binds
    // before the token and line limits (punctuation would cost one token per byte).
    ['byte-heavy', `${Array.from({ length: 40 }, (_, index) => `const v${String(index)}${'a'.repeat(200)} = 1;`).join('\n')}\n`],
  ];
  const profiles: readonly WindowLimits[] = [
    DEFAULT_WINDOW_LIMITS,
    { ...DEFAULT_WINDOW_LIMITS, targetLines: 4, maxLines: 5, overlapLines: 0, maxBytes: 256, maxTokens: 64 },
    { ...DEFAULT_WINDOW_LIMITS, targetLines: 3, maxLines: 3, overlapLines: 2, maxBytes: 128, maxTokens: 32 },
    { ...DEFAULT_WINDOW_LIMITS, targetLines: 200, maxLines: 500, overlapLines: 8, maxBytes: 64 * 1_024, maxTokens: 4_000 },
    // Bytes bind here: one line is ~215 bytes and ~55 tokens, so two lines fit by tokens
    // (110 of 400) and by lines (2 of 8) but not by bytes (430 of 250).
    { ...DEFAULT_WINDOW_LIMITS, targetLines: 4, maxLines: 8, overlapLines: 1, maxBytes: 250, maxTokens: 400 },
  ];

  for (const [name, text] of sources) {
    for (const [profileIndex, limits] of profiles.entries()) {
      const label = `${name} profile ${String(profileIndex)}`;
      const result = lineWindows(snapshot(text, `src/${name}.ts`), limits);

      // A rejection must be justified: it is allowed only when some single line cannot fit a
      // legal window, and then the report must name that line.
      const contents = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
      if (text.endsWith('\n')) {
        contents.pop();
      }
      const unfittableIndex = contents.findIndex(
        (content) => utf8(content).length > limits.maxBytes || countReferenceTokens(content) > limits.maxTokens,
      );
      if (unfittableIndex !== -1) {
        assert.equal(result.kind, 'unsupported-long-line', `${label}: a line that cannot fit must be reported`);
        if (result.kind === 'unsupported-long-line') {
          assert.equal(result.line, unfittableIndex + 1, `${label}: the wrong line was reported`);
          assert.equal(result.reason, 'unsupported_long_line');
        }
        continue;
      }

      assert.equal(result.kind, 'windows', `${label} was rejected without an unfittable line`);
      if (result.kind !== 'windows') {
        continue;
      }

      const covered = coveredLines(result.windows);
      for (const line of nonblankLines(text)) {
        assert.ok(covered.has(line), `${label}: line ${String(line)} uncovered`);
      }

      const bytes = utf8(text);
      let overlappingPairs = 0;
      for (const window of result.windows) {
        const lineCount = window.endLine - window.startLine + 1;
        assert.ok(lineCount <= limits.maxLines, `${label}: ${String(lineCount)} lines`);
        assert.ok(window.byteCount <= limits.maxBytes, `${label}: ${String(window.byteCount)} bytes`);
        assert.ok(window.tokenCount <= limits.maxTokens, `${label}: ${String(window.tokenCount)} tokens`);
        assert.equal(window.text, bytes.subarray(window.byteStart, window.byteEnd).toString('utf8'));
        assert.equal(window.text.trim().length > 0, true, `${label}: a blank window was emitted`);
        assert.equal(window.classification, 'line-window');
      }

      for (let index = 1; index < result.windows.length; index += 1) {
        const previous = result.windows[index - 1];
        const current = result.windows[index];
        assert.ok(previous !== undefined);
        assert.ok(current !== undefined);
        assert.ok(current.startLine > previous.startLine, `${label}: windows must progress`);
        assert.ok(current.startLine <= previous.endLine + 1, `${label}: a gap was introduced`);
        if (current.startLine <= previous.endLine) {
          overlappingPairs += 1;
        }
      }

      // Overlap is applied whenever it is configured and a non-final window is longer than
      // the overlap budget. A window of one line cannot overlap without stalling progress,
      // which is why the condition is not simply `windows.length > 1`.
      const splittable = result.windows
        .slice(0, -1)
        .some((window) => window.endLine - window.startLine + 1 > limits.overlapLines);
      if (limits.overlapLines > 0 && splittable) {
        assert.ok(overlappingPairs > 0, `${label}: overlap was configured but never applied`);
      }
      if (limits.overlapLines === 0) {
        assert.equal(overlappingPairs, 0, `${label}: overlap must not appear when it is disabled`);
      }
    }
  }
});

test('overlapping windows keep one file identity and never repeat a range', () => {
  // JG-012 acceptance criterion 5: overlap must not duplicate the inventoried file, and the
  // returned ranges must stay distinct. A caller can therefore group windows by path and
  // treat the group as one file, whatever the overlap policy did.
  const text = longSource(240);
  const limits: WindowLimits = { ...DEFAULT_WINDOW_LIMITS, targetLines: 12, maxLines: 12, overlapLines: 4, maxBytes: 4_096, maxTokens: 400 };
  const result = lineWindows(snapshot(text, 'src/orders.ts'), limits);

  assert.equal(result.kind, 'windows');
  if (result.kind !== 'windows') {
    return;
  }
  assert.ok(result.windows.length > 2, 'the file must be split for this check to mean anything');

  const identities = new Set(result.windows.map((window) => `${window.path}\u0000${window.sha256}`));
  assert.equal(identities.size, 1, 'overlap must not invent a second file identity');

  const ranges = result.windows.map((window) => `${String(window.startLine)}-${String(window.endLine)}`);
  assert.equal(new Set(ranges).size, ranges.length, 'a window range must not be emitted twice');

  const ids = result.windows.map((window) => window.id);
  assert.equal(new Set(ids).size, ids.length, 'window identifiers must stay unique under overlap');

  // Grouping by path yields exactly one file, with every window contributing original bytes.
  const byPath = new Map<string, typeof result.windows>();
  for (const window of result.windows) {
    const group = byPath.get(window.path) ?? [];
    byPath.set(window.path, [...group, window]);
    assert.equal(Buffer.from(text, 'utf8').subarray(window.byteStart, window.byteEnd).toString('utf8'), window.text);
  }
  assert.deepEqual([...byPath.keys()], ['src/orders.ts']);
  assert.equal(byPath.get('src/orders.ts')?.length, result.windows.length);
});
