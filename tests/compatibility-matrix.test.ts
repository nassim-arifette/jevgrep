import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * JG-026: the compatibility matrix is a deliverable that must not drift from the repository,
 * and it must not claim an integration that was never run. The pinned versions it names are
 * checked against the files that own them, and the unverified areas must stay labelled.
 */
const matrix = readFileSync(join(repoRoot, 'docs', 'compatibility.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();

test('the matrix names the runtime the repository pins', () => {
  assert.ok(matrix.includes(nvmrc), `the matrix must name the pinned Node.js version ${nvmrc}`);
  const major = nvmrc.split('.')[0] ?? '';
  assert.ok((manifest.engines?.node ?? '').includes(`>=${major}.`), 'engines and .nvmrc must agree');
});

test('every pinned dependency the matrix mentions matches package.json', () => {
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (matrix.toLowerCase().includes(name.toLowerCase())) {
      assert.ok(
        matrix.includes(version),
        `the matrix mentions ${name} but not its pinned version ${version}`,
      );
    }
  }
  const lower = matrix.toLowerCase();
  assert.ok(lower.includes('typescript'), 'the compiler belongs in the matrix');
  assert.ok(lower.includes('tiktoken'), 'the start-up tokenizer belongs in the matrix');
});

test('the unverified areas stay labelled unverified', () => {
  for (const claim of ['Codex', 'Provider account behaviour']) {
    assert.ok(matrix.includes(claim), `the matrix must address ${claim}`);
  }
  assert.match(matrix, /Unverified|unverified/, 'the matrix must mark what was not run');
  assert.match(matrix, /has not run yet|unproven/, 'the CI workflow itself must not be presented as proven');
});
