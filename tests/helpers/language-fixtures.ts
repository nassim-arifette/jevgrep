import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { countReferenceTokens } from '../../src/response/token-counter.ts';
import { DEFAULT_CHUNKER, DEFAULT_WINDOW_LIMITS, uncoveredNonBlankLines, type ChunkResult, type WindowLimits } from '../../src/source/chunker.ts';
import { createSnapshot } from '../../src/source/snapshot.ts';

/**
 * Golden language fixtures (language search spec 9.2): `tests/fixtures/languages/<profile>/<case>.<ext>`
 * with the expected chunk result next to it in `<case>.<ext>.json`. See the README there.
 */

export const LANGUAGE_FIXTURES_ROOT = join(import.meta.dirname, '../fixtures/languages');

export type ExpectedFragment = {
  /** Inclusive 1-based line range. */
  readonly lines: readonly [number, number];
  readonly label: string | null;
  /** The declaration's line range when the fragment is one window of a split declaration. */
  readonly declaration?: readonly [number, number];
};

export type LanguageFixture = {
  readonly description: string;
  /** Overrides of the default window limits, e.g. a small token target to force splits. */
  readonly limits?: Partial<WindowLimits>;
  readonly strategy: 'syntax' | 'line-window';
  readonly fallback: string | null;
  readonly fragments: readonly ExpectedFragment[];
};

export type LanguageFixtureCase = { readonly profile: string; readonly name: string; readonly sourcePath: string; readonly expectedPath: string };

/** Every fixture case, in profile then file order. */
export function languageFixtureCases(root = LANGUAGE_FIXTURES_ROOT): LanguageFixtureCase[] {
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    .flatMap((profile) => readdirSync(join(root, profile)).filter((name) => !name.endsWith('.json')).sort().map((name) => ({
      profile, name, sourcePath: join(root, profile, name), expectedPath: join(root, profile, `${name}.json`),
    })));
}

/** The chunk result of a fixture in the expected-file shape. */
export function chunkFixture(fixtureCase: LanguageFixtureCase, limits: Partial<WindowLimits> = {}): Omit<LanguageFixture, 'description' | 'limits'> {
  const snapshot = createSnapshot(fixtureCase.name, fixtureCase.sourcePath, readFileSync(fixtureCase.sourcePath), countReferenceTokens);
  const result: ChunkResult = DEFAULT_CHUNKER.chunk(snapshot, { ...DEFAULT_WINDOW_LIMITS, ...limits });
  assert.equal(result.kind, 'fragments', `${fixtureCase.profile}/${fixtureCase.name} is not chunkable`);
  assert.ok(result.kind === 'fragments');
  for (const fragment of result.fragments) {
    assert.equal(fragment.text, snapshot.sliceLines(fragment.startLine, fragment.endLine).text, 'fragments are exact slices');
  }
  assert.deepEqual(uncoveredNonBlankLines(snapshot, result.fragments), [], 'every non-blank line is covered');
  return {
    strategy: result.strategy, fallback: result.fallback,
    fragments: result.fragments.map((fragment) => ({
      lines: [fragment.startLine, fragment.endLine], label: fragment.label ?? null,
      ...(fragment.declaration == null ? {} : { declaration: [fragment.declaration.startLine, fragment.declaration.endLine] as const }),
    })),
  };
}

/**
 * Assert a fixture's chunk result equals its expected file. With
 * `JEVGREP_UPDATE_LANGUAGE_FIXTURES=1` the expected file is rewritten instead, keeping
 * its description and limits; review the diff before committing it.
 */
export function assertLanguageFixture(fixtureCase: LanguageFixtureCase): void {
  const expected = JSON.parse(readFileSync(fixtureCase.expectedPath, 'utf8')) as LanguageFixture;
  const actual = chunkFixture(fixtureCase, expected.limits);
  if (process.env['JEVGREP_UPDATE_LANGUAGE_FIXTURES'] === '1') {
    const updated = { description: expected.description, ...(expected.limits === undefined ? {} : { limits: expected.limits }), ...actual };
    writeFileSync(fixtureCase.expectedPath, `${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  assert.deepEqual(actual, { strategy: expected.strategy, fallback: expected.fallback, fragments: expected.fragments });
}
