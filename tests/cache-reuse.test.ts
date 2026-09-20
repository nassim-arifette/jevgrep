import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/jev.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

test('changing a neighboring question invalidates a batch until independence is qualified', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'const a = 1;\n', 'b.ts': 'const b = 1;\n' } });
  let calls = 0;
  const provider: ProviderClient = { model: 'jev-1.13.0', async evaluateBatch(batch) {
    calls++;
    return { scores: new Map(batch.items.map((i) => [i.id, 0.9])), invalid: [],
      usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 0, requestId: null };
  } };
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    await engine.search({ query: 'q' });
    await engine.search({ query: 'q' });
    assert.equal(calls, 1);
    space.write('b.ts', 'const b = 2;\n');
    const { outcome } = await engine.search({ query: 'q' });
    assert.ok('report' in outcome);
    assert.equal(calls, 2);
    assert.equal(outcome.report.fragments.cache_reused, 0);
    assert.equal(outcome.report.fragments.remote_evaluated, 2);
  } finally { space.cleanup(); }
});

for (const [model, returned] of [['jev-latest', 'jev-1.13.0'], ['jev-2', 'jev-2'], ['jev-1.13.0', 'jev-1.14.0']]) {
  test(`cache does not reuse an unresolved or mismatched model (${model} -> ${returned})`, async () => {
    const space = createWorkspace({ files: { 'a.ts': 'const a = 1;\n' } }); let calls = 0;
    const provider: ProviderClient = { model: model!, async evaluateBatch(batch) {
      calls++;
      return { scores: new Map(batch.items.map((i) => [i.id, 0.9])), invalid: [], usage: { inputTokens: 1, outputTokens: 0 },
        requestedModel: model!, returnedModel: returned!, transmittedBytes: 0, requestId: null };
    } };
    try {
      const engine = createSearchEngine({ configuration: space.loaded, provider });
      await engine.search({ query: 'q' }); await engine.search({ query: 'q' });
      assert.equal(calls, 2); assert.equal(engine.cache.stats.writes, 0);
    } finally { space.cleanup(); }
  });
}
