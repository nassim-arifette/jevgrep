import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/jev.ts';
import { countProfile, measureAsync, measureSync, SearchProfiler, withSearchProfile } from '../src/profiling.ts';
import { ManualClock } from '../src/testing/manual-clock.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

test('profiles isolate concurrent async work, retain failed spans and release context', async () => {
  const first = new SearchProfiler();
  const second = new SearchProfiler();
  await Promise.all([
    withSearchProfile(first, async () => {
      await measureAsync('provider', async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        countProfile('attempts', 2);
      });
      assert.throws(() => measureSync('decode', () => { throw new Error('invalid bytes'); }));
    }),
    withSearchProfile(second, async () => {
      countProfile('attempts', 7);
      await withSearchProfile(undefined, async () => { countProfile('attempts', 100); });
    }),
  ]);
  countProfile('attempts', 1_000);
  assert.equal(first.snapshot().counters['attempts'], 2);
  assert.equal(second.snapshot().counters['attempts'], 7);
  assert.equal(first.snapshot().stages.decode?.calls, 1);
  assert.equal(first.snapshot().stages.provider?.calls, 1);
  assert.equal(second.snapshot().stages.provider, undefined);
  assert.ok(first.snapshot().memory.sampledMax.rssBytes >= first.snapshot().memory.start.rssBytes);
  const snapshot = first.snapshot();
  snapshot.stages.search!.calls = 99;
  assert.equal(first.snapshot().stages.search?.calls, 1);
  await assert.rejects(withSearchProfile(first, async () => {}), /new SearchProfiler/);
});

test('profiling leaves outcomes unchanged and records real engine stages without source', async () => {
  const source = 'export function distinctive_private_name(value: number) { return value + 1; }\n';
  const space = createWorkspace({ files: { 'src/example.ts': source }, configure: (base) => ({ ...base, cache: { ...base.cache, enabled: false } }) });
  const provider: ProviderClient = {
    model: 'jev-1.13.0',
    async evaluateBatch(batch) {
      return {
        scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
        usage: { inputTokens: 100, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
        transmittedBytes: 500, requestId: null,
      };
    },
  };
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider, clock: new ManualClock() });
    const request = { query: 'What increments the value?', scope: ['.'], max_context_tokens: 4_000 };
    const plain = await engine.search(request, { searchId: 'profile-equivalence' });
    const profile = new SearchProfiler();
    const measured = await engine.search(request, { searchId: 'profile-equivalence', profile });
    assert.deepEqual(measured, plain);
    const snapshot = profile.snapshot();
    for (const stage of ['inventory', 'source_read', 'decode', 'hash', 'secret_scan', 'parsing', 'tokenization', 'batching', 'planning', 'provider', 'selection', 'freshness', 'rendering'] as const) {
      assert.ok((snapshot.stages[stage]?.calls ?? 0) > 0, stage);
    }
    assert.ok((snapshot.counters['serializedQuestions'] ?? 0) > 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /distinctive_private_name|src\/example|What increments/);
  } finally { space.cleanup(); }
});
