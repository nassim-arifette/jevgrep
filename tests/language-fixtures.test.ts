import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syntaxLanguageOf } from '../src/source/chunker.ts';
import { assertLanguageFixture, languageFixtureCases } from './helpers/language-fixtures.ts';

/** Golden per-profile fixtures: exact fragment ranges, labels and back-references of today's chunkers. */

const cases = languageFixtureCases();

test('every current syntax language has a golden fixture', () => {
  assert.deepEqual([...new Set(cases.map((fixture) => syntaxLanguageOf(fixture.name)))].sort(), ['go', 'java', 'javascript', 'python', 'rust']);
});

for (const fixture of cases) {
  test(`language fixture ${fixture.profile}/${fixture.name}`, () => {
    assertLanguageFixture(fixture);
  });
}
