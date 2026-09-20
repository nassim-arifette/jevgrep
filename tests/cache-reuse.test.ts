import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/jev.ts';
import { createWorkspace } from './helpers/search-workspace.ts';
import { serializeGatewayBatch } from '../src/evaluation/vercel-gateway.ts';
import { inspectScope } from '../src/inspect.ts';
import { doctorReport, renderDoctorReport } from '../src/config.ts';

test('changing a neighboring question re-evaluates only that independent question', async () => {
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
    assert.equal(outcome.report.fragments.cache_reused, 1);
    assert.equal(outcome.report.fragments.remote_evaluated, 1);
  } finally { space.cleanup(); }
});

test('Gateway reuses rolling scores across sessions, misses changed queries, and can opt out', async () => {
  const space = createWorkspace({ files: { 'auth.ts': 'export function authenticate() { return true; }\n' },
    configure: (config) => ({ ...config, provider: { ...config.provider,
      adapter: 'vercel-ai-gateway', model: 'typesafe-ai/jev', base_url: 'https://ai-gateway.vercel.sh' } }) });
  let calls = 0;
  const provider: ProviderClient = { model: 'typesafe-ai/jev', serializeBatch: serializeGatewayBatch,
    async evaluateBatch(batch) {
      calls++;
      return { scores: new Map(batch.items.map((i) => [i.id, 0.9])), invalid: [],
        usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: null,
        transmittedBytes: 0, requestId: null };
    } };
  try {
    const query = 'Where is authentication?';
    const inspection = inspectScope(space.loaded, { scope: ['.'], sampleQuery: query });
    const first = (await createSearchEngine({ configuration: space.loaded, provider }).search({ query })).outcome;
    assert.ok('report' in first);
    assert.equal(first.report.preflight.estimated_first_attempt_tokens, inspection.estimates.input_tokens);
    assert.equal(first.report.preflight.estimated_first_attempt_requests, inspection.estimates.requests);
    const second = (await createSearchEngine({ configuration: space.loaded, provider }).search({ query })).outcome;
    assert.ok('report' in second);
    assert.equal(calls, 1);
    assert.equal(second.report.fragments.cache_reused, 1);
    assert.equal(second.report.usage.provider_request_attempts, 0);
    await createSearchEngine({ configuration: space.loaded, provider }).search({ query: 'Different question?' });
    assert.equal(calls, 2);
    const report = doctorReport(space.loaded, {});
    assert.equal(report.cache.policy, 'rolling');
    assert.equal(report.cache.effective_ttl_seconds, 900);
    assert.match(renderDoctorReport(report).join('\n'), /model revision unverified/);
    const noRolling = { ...space.loaded, config: { ...space.loaded.config,
      cache: { ...space.loaded.config.cache, rolling_ttl_seconds: 0 } } };
    const engine = createSearchEngine({ configuration: noRolling, provider });
    await engine.search({ query });
    assert.equal(calls, 3);
    assert.equal(engine.cache.stats.writes, 0);
  } finally { space.cleanup(); }
});

test('an existing direct rolling alias uses short-lived reuse without claiming it is pinned', async () => {
  const space = createWorkspace({ files: { 'auth.py': 'def authenticate():\n    return True\n' },
    configure: (config) => ({ ...config, provider: { ...config.provider, model: 'jev-latest' } }) });
  let calls = 0;
  const provider: ProviderClient = { model: 'jev-latest', async evaluateBatch(batch) {
    calls++;
    return { scores: new Map(batch.items.map((i) => [i.id, 0.9])), invalid: [],
      usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: 'jev-1.13.0',
      transmittedBytes: 0, requestId: null };
  } };
  try {
    await createSearchEngine({ configuration: space.loaded, provider }).search({ query: 'auth' });
    await createSearchEngine({ configuration: space.loaded, provider }).search({ query: 'auth' });
    assert.equal(calls, 1);
    assert.equal(doctorReport(space.loaded, {}).cache.policy, 'rolling');
  } finally { space.cleanup(); }
});

for (const [model, returned] of [['jev-2', 'jev-2'], ['jev-1.13.0', 'jev-1.14.0']]) {
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
