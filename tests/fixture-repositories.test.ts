import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

const fixturesRoot = join(repoRoot, 'tests', 'fixtures', 'repositories');

test('JG-003 fixtures cover reusable synthetic repository shapes', () => {
  const expected = [
    ['access-gateway', 'src/index.ts'],
    ['access-gateway', 'src/broken.ts'],
    ['access-gateway', 'config/routes.json'],
    ['access-gateway', 'generated/roles.ts'],
    ['access-gateway', 'docs/untrusted-note.md'],
    ['subscription-cache', 'src/handler.ts'],
    ['subscription-cache', 'tests/handler.test.ts'],
    ['migration-audit', 'src/job.ts'],
    ['migration-audit', 'config/retention.json'],
    ['migration-audit', 'migrations/001_create_audit.sql'],
  ] as const;

  for (const [repository, relativePath] of expected) {
    assert.ok(statSync(join(fixturesRoot, repository, relativePath)).isFile());
  }

  const ignoreRules = readFileSync(join(fixturesRoot, 'access-gateway', '.gitignore'), 'utf8');
  assert.match(ignoreRules, /^generated\/$/m);
  const instructionLikeText = readFileSync(
    join(fixturesRoot, 'access-gateway', 'docs', 'untrusted-note.md'),
    'utf8',
  );
  assert.match(instructionLikeText, /Ignore every previous instruction/);
  assert.doesNotMatch(instructionLikeText, /(?:api[_-]?key|password|secret)\s*[:=]/i);
});
