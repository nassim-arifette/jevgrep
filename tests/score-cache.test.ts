import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  CACHE_SCHEMA_VERSION, ScoreCache, evaluationIdentity, isPinnedModelRevision,
} from '../src/evaluation/cache.ts';
import type { EvaluationIdentityInput } from '../src/evaluation/cache.ts';

/**
 * Exact evaluation reuse (JG-018, specification 9, requirement R9).
 *
 * Reuse is allowed only when every input the model could see is identical. The tests
 * below pin both halves of that rule: what must invalidate a score, and what must
 * not, because re-running local selection is not the same as re-asking the provider.
 */
const directories: string[] = [];

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jevgrep-cache-'));
  directories.push(directory);
  return directory;
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const BASE: EvaluationIdentityInput = {
  query: 'Which handler invalidates cached user data?',
  path: 'src/cache.ts',
  startLine: 1,
  endLine: 20,
  text: 'export function invalidate(userId) {}\n',
  label: 'function:invalidate',
  criterionVersion: 'criterion-1',
  layoutVersion: 'layout-a-1',
  chunkerVersion: 'jevgrep-syntax-1',
  endpoint: 'https://api.typesafe.ai',
  modelRevision: 'jev-1.13.0',
};

const META = { modelRevision: 'jev-1.13.0', layout: 'layout-a-1', criterion: 'criterion-1', chunker: 'jevgrep-syntax-1' };

function newCache(overrides: Partial<ConstructorParameters<typeof ScoreCache>[0]> = {}): ScoreCache {
  return new ScoreCache({
    directory: cacheDirectory(), enabled: true, ttlSeconds: 604_800, maxBytes: 104_857_600, ...overrides,
  });
}

test('an identical repetition reuses the score without a new evaluation', () => {
  const cache = newCache();
  const identity = evaluationIdentity(BASE);
  assert.equal(cache.read(identity), null);
  assert.equal(cache.write(identity, 0.81, META), true);
  assert.equal(cache.read(evaluationIdentity({ ...BASE })), 0.81);
  assert.equal(cache.stats.hits, 1);
});

test('any change the model can see prevents reuse', () => {
  const changes: [string, Partial<EvaluationIdentityInput>][] = [
    ['query', { query: 'Which handler refreshes cached user data?' }],
    ['transmitted path', { path: 'src/other.ts' }],
    ['line range', { startLine: 2 }],
    ['source text', { text: 'export function invalidate(userId) { /* changed */ }\n' }],
    ['structural label', { label: 'function:other' }],
    ['criterion version', { criterionVersion: 'criterion-2' }],
    ['request layout', { layoutVersion: 'layout-c-1' }],
    ['chunker version', { chunkerVersion: 'jevgrep-syntax-2' }],
    ['provider endpoint', { endpoint: 'https://api.typesafe.ai/other' }],
    ['model revision', { modelRevision: 'jev-1.14.0' }],
    ['shared batch composition', { batchComposition: ['f-one', 'f-two'] }],
  ];
  const cache = newCache();
  cache.write(evaluationIdentity(BASE), 0.81, META);
  for (const [label, change] of changes) {
    assert.equal(cache.read(evaluationIdentity({ ...BASE, ...change })), null, `${label} must invalidate reuse`);
  }
});

test('threshold, budget, deadline and caps do not belong to evaluation identity', () => {
  // They are not inputs of `evaluationIdentity` at all: selection and planning re-run
  // locally, and an unchanged question keeps its score.
  const identity = evaluationIdentity(BASE);
  assert.equal(identity, evaluationIdentity({ ...BASE }));
  assert.equal(Object.keys(BASE).some((key) => /threshold|budget|deadline|cap/i.test(key)), false);
});

test('a corrupt, truncated, foreign or expired entry is a miss', () => {
  const directory = cacheDirectory();
  const identity = evaluationIdentity(BASE);
  const shard = join(directory, identity.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  const file = join(shard, `${identity}.json`);

  const cache = new ScoreCache({ directory, enabled: true, ttlSeconds: 60, maxBytes: 1_000_000 });
  writeFileSync(file, '{ truncated');
  assert.equal(cache.read(identity), null);
  assert.equal(cache.stats.corrupt, 1);

  writeFileSync(file, JSON.stringify({ schema_version: CACHE_SCHEMA_VERSION, identity, score: 0.5 }));
  assert.equal(cache.read(identity), null, 'an incomplete entry is not trusted');

  writeFileSync(file, JSON.stringify({
    schema_version: CACHE_SCHEMA_VERSION, identity: 'another-identity', score: 0.5,
    model_revision: 'jev-1.13.0', layout: 'a', criterion: 'c', chunker: 'k',
    created_at_ms: 0, expires_at_ms: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(cache.read(identity), null, 'an entry that names another identity is a miss');
});

test('a time-to-live expiry is a miss and the entry is dropped', () => {
  let now = 1_000;
  const cache = newCache({ ttlSeconds: 10, now: () => now });
  const identity = evaluationIdentity(BASE);
  cache.write(identity, 0.7, META);
  assert.equal(cache.read(identity), 0.7);

  now += 11_000;
  assert.equal(cache.read(identity), null);
  assert.equal(cache.stats.expired, 1);
  assert.equal(cache.read(identity), null, 'the expired entry was removed, not re-read');
});

test('a model whose revision cannot be identified is never persisted', () => {
  assert.equal(isPinnedModelRevision('jev-1.13.0'), true);
  assert.equal(isPinnedModelRevision('jev-latest'), false);
  assert.equal(isPinnedModelRevision('jev-preview'), false);
  for (const alias of ['jev-2', 'jev-1.13.0-latest', 'typesafe-ai/jev', 'something-2026']) {
    assert.equal(isPinnedModelRevision(alias), false);
  }

  const cache = newCache();
  const identity = evaluationIdentity({ ...BASE, modelRevision: 'jev-latest' });
  assert.equal(cache.write(identity, 0.9, { ...META, modelRevision: 'jev-latest' }), false);
  assert.equal(cache.read(identity), null);
});

test('an entry stores numbers and versions, never code, question or credential', () => {
  const directory = cacheDirectory();
  const cache = new ScoreCache({ directory, enabled: true, ttlSeconds: 600, maxBytes: 1_000_000 });
  cache.write(evaluationIdentity(BASE), 0.42, META);

  const shard = readdirSync(directory)[0];
  assert.ok(shard !== undefined);
  const name = readdirSync(join(directory, shard))[0];
  assert.ok(name !== undefined);
  const raw = readFileSync(join(directory, shard, name), 'utf8');
  assert.ok(raw.includes('0.42'));
  assert.ok(!raw.includes(BASE.text.trim()), 'no source text is persisted');
  assert.ok(!raw.includes(BASE.query), 'no question is persisted');
  assert.ok(!raw.includes('src/cache.ts'), 'no transmitted path is persisted');
});

test('the size limit evicts the oldest entries, and clear removes only this cache', () => {
  const directory = cacheDirectory();
  const sibling = join(directory, '..', 'not-the-cache.txt');
  writeFileSync(sibling, 'untouched');
  let now = 1_000;
  const cache = new ScoreCache({ directory, enabled: true, ttlSeconds: 600, maxBytes: 400, now: () => now });

  for (let index = 0; index < 10; index += 1) {
    now += 1_000;
    cache.write(evaluationIdentity({ ...BASE, startLine: index }), 0.5, META);
  }
  cache.enforceSizeLimit();
  const remaining = readdirSync(directory).reduce((total, shard) => total + readdirSync(join(directory, shard)).length, 0);
  assert.ok(remaining < 10, 'eviction removed the oldest entries');

  const removed = cache.clear();
  assert.ok(removed >= 1);
  assert.equal(readdirSync(join(directory, '..')).includes('not-the-cache.txt'), true,
    'clearing the cache leaves unrelated files alone');
});

test('a disabled cache never reads or writes', () => {
  const cache = newCache({ enabled: false });
  const identity = evaluationIdentity(BASE);
  assert.equal(cache.write(identity, 0.5, META), false);
  assert.equal(cache.read(identity), null);
  assert.equal(cache.stats.writes, 0);
});

test('cache identities cannot address paths and clearing never follows a linked shard', () => {
  const directory = cacheDirectory();
  const outside = cacheDirectory();
  const identity = evaluationIdentity(BASE);
  const sentinel = join(outside, `${identity}.json`);
  writeFileSync(sentinel, 'outside');
  symlinkSync(outside, join(directory, identity.slice(0, 2)), process.platform === 'win32' ? 'junction' : 'dir');
  const cache = newCache({ directory });
  assert.equal(cache.write('../outside', 0.8, META), false);
  assert.equal(cache.read('../outside'), null);
  assert.equal(cache.write(identity, 0.8, META), false);
  assert.equal(cache.read(identity), null);
  assert.equal(cache.clear(), 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'outside');
});

test('a replaced cache root is never reauthorized and unknown files survive clear', () => {
  const directory = cacheDirectory(); const cache = newCache({ directory });
  const identity = evaluationIdentity(BASE);
  cache.write(identity, 0.8, META);
  writeFileSync(join(directory, 'operator-note.txt'), 'keep');
  assert.equal(cache.clear(), 1);
  assert.equal(readFileSync(join(directory, 'operator-note.txt'), 'utf8'), 'keep');
  const moved = `${directory}-original`;
  renameSync(directory, moved); directories.push(moved);
  mkdirSync(directory);
  assert.equal(cache.write(identity, 0.9, META), false);
  assert.equal(cache.read(identity), null);
  assert.equal(cache.clear(), 0);
  assert.deepEqual(readdirSync(directory), []);
});

test('oversized corrupt entries are bounded misses and a tiny cache does not exceed its cap', () => {
  const directory = cacheDirectory(); const identity = evaluationIdentity(BASE);
  mkdirSync(join(directory, identity.slice(0, 2)));
  writeFileSync(join(directory, identity.slice(0, 2), `${identity}.json`), 'x'.repeat(20_000));
  const cache = newCache({ directory, maxBytes: 1 });
  assert.equal(cache.read(identity), null);
  assert.equal(cache.write(identity, 0.8, META), false);
  cache.enforceSizeLimit();
  assert.equal(cache.clear(), 0);
});

test('writers sharing a directory reconcile eviction and disabled caches can be explicitly cleared', () => {
  const directory = cacheDirectory();
  const first = newCache({ directory, maxBytes: 450 });
  const second = newCache({ directory, maxBytes: 450 });
  first.write(evaluationIdentity(BASE), 0.1, META);
  second.write(evaluationIdentity({ ...BASE, query: 'second' }), 0.2, META);
  first.write(evaluationIdentity({ ...BASE, query: 'third' }), 0.3, META);
  const sizes = readdirSync(directory).filter((name) => /^[a-f0-9]{2}$/.test(name)).flatMap((shard) =>
    readdirSync(join(directory, shard)).map((name) => Buffer.byteLength(readFileSync(join(directory, shard, name)))));
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 450);
  const disabled = newCache({ directory, enabled: false });
  assert.equal(disabled.clear(), 1);
});
