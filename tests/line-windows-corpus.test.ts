import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_WINDOW_LIMITS, lineWindows } from '../src/source/line-windows.ts';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * JG-012 acceptance criterion 1, exercised on the real fixture material of this repository:
 * every nonblank line of a prepared file must be covered by at least one window, every
 * window must be an exact original slice, and the result must be deterministic.
 *
 * This is a coverage net over real content (config, Markdown, SQL, deliberately broken
 * source), not a replacement for tests/line-windows.test.ts, which pins the limits and the
 * overlap behaviour.
 */
const fixtureRoots = ['benchmarks/fixtures', 'tests/fixtures'] as const;

function collectFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(path));
    } else if (entry.isFile() && statSync(path).size < 512 * 1_024) {
      found.push(path);
    }
  }
  return found;
}

function nonblankLines(text: string): number[] {
  return text
    .split('\n')
    .map((line, index) => ({ content: line.endsWith('\r') ? line.slice(0, -1) : line, number: index + 1 }))
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => entry.number);
}

test('every nonblank line of every fixture file is covered by an exact original slice', () => {
  const files = fixtureRoots.flatMap((root) => collectFiles(join(repoRoot, root)));
  assert.ok(files.length >= 40, `expected the fixture corpus, found ${String(files.length)} files`);

  let windowTotal = 0;
  for (const absolute of files) {
    const raw = readFileSync(absolute);
    if (raw.includes(0)) {
      continue; // binary material is refused by the snapshot, not chunked here
    }
    const text = raw.toString('utf8');
    const path = relative(repoRoot, absolute).replaceAll('\\', '/');
    const result = lineWindows({ path, text, sha256: 'a'.repeat(64) });

    assert.equal(result.kind, 'windows', `${path} was refused: ${JSON.stringify(result)}`);
    if (result.kind !== 'windows') {
      continue;
    }

    const covered = new Set<number>();
    for (const window of result.windows) {
      for (let line = window.startLine; line <= window.endLine; line += 1) {
        covered.add(line);
      }
      assert.equal(window.text, raw.subarray(window.byteStart, window.byteEnd).toString('utf8'), `${path} slice`);
      assert.equal(window.path, path);
      assert.equal(window.byteCount, Buffer.byteLength(window.text, 'utf8'));
      assert.ok(window.byteCount <= DEFAULT_WINDOW_LIMITS.maxBytes, `${path} bytes`);
      assert.ok(window.endLine - window.startLine + 1 <= DEFAULT_WINDOW_LIMITS.maxLines, `${path} lines`);
      assert.ok(window.tokenCount <= DEFAULT_WINDOW_LIMITS.maxTokens, `${path} tokens`);
    }
    windowTotal += result.windows.length;

    for (const line of nonblankLines(text)) {
      assert.ok(covered.has(line), `${path}: line ${String(line)} is not covered`);
    }

    // Determinism on real input, not only on generated input.
    assert.deepEqual(
      lineWindows({ path, text, sha256: 'a'.repeat(64) }),
      result,
      `${path} is not deterministic`,
    );
  }

  assert.ok(windowTotal >= files.length, `expected at least one window per file, got ${String(windowTotal)}`);
});
