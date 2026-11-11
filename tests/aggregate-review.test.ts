import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_LIMITS, createSearchManyRequestSchema, multiquestionResponseReserve } from '../src/contracts.ts';
import { RequestValidationError, createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { createWorkspace } from './helpers/search-workspace.ts';
import { UnauthorizedPathError } from '../src/source/authorization.ts';
import { SearchProfiler } from '../src/profiling.ts';

function provider(): ProviderClient & { calls: number } {
  return { model: 'jev-1.13.0', calls: 0, async evaluateBatch(batch) {
    this.calls += 1;
    return { scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
      usage: { inputTokens: 1, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 0, requestId: null };
  } };
}

for (const count of [1, 2, 16]) {
  test(`the aggregate response minimum includes wrapper room for ${String(count)} questions`, async () => {
    const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
    try {
      const client = provider();
      const engine = createSearchEngine({ configuration: space.loaded, provider: client });
      const questions = Array.from({ length: count }, (_, index) => ({ query: `question ${String(index)}` }));
      const minimum = CONTRACT_LIMITS.min_response_tokens * count + multiquestionResponseReserve(count);
      assert.throws(() => createSearchManyRequestSchema().parse({ questions, max_context_tokens: minimum - 1 }));
      await assert.rejects(engine.searchMany(questions, { max_context_tokens: minimum - 1 }), RequestValidationError);
      assert.equal(client.calls, 0);
      const results = await engine.searchMany(questions, { max_context_tokens: minimum });
      assert.ok(results.every(({ outcome }) => 'report' in outcome), 'the accepted minimum must never allocate a sub-minimum question budget');
      assert.ok(countReferenceTokens(JSON.stringify({ results: results.map(({ outcome }) => outcome) })) <= minimum);
    } finally { space.cleanup(); }
  });
}

test('all per-question and aggregate cost budgets require pricing before any search work', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const client = provider();
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    await assert.rejects(engine.searchMany([{ query: 'first' }, { query: 'second' }], { max_cost_usd: 1 }), RequestValidationError);
    await assert.rejects(engine.searchMany([{ query: 'first' }, { query: 'second', max_cost_usd: 1 }]), RequestValidationError);
    assert.equal(client.calls, 0);
    assert.equal(engine.preparationCache.stats.hits + engine.preparationCache.stats.misses, 0);
  } finally { space.cleanup(); }
});

test('a cancellation queued during warm cache lookup is handled before the next bounded group', async (t) => {
  const space = createWorkspace({ files: Object.fromEntries(Array.from({ length: 80 }, (_, index) =>
    [`${String(index)}.ts`, `export const a${String(index)} = ${String(index)};\n`])) });
  try {
    const client = provider();
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    const controller = new AbortController();
    let reads = 0;
    t.mock.method(engine.cache, 'read', () => {
      reads += 1;
      if (reads === 1) setImmediate(() => controller.abort());
      return 0.9;
    });
    const { outcome } = await engine.search({ query: 'a' }, { signal: controller.signal });
    assert.ok('error' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.error.code, 'CANCELLED');
    assert.ok(reads > 0 && reads <= 32, `cancellation arrived after ${String(reads)} cache reads`);
    assert.equal(client.calls, 0);
  } finally { space.cleanup(); }
});

test('a compact error after dispatch still settles the aggregate input reservation', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const client = provider();
    client.evaluateBatch = async () => {
      client.calls += 1;
      throw new UnauthorizedPathError('not_regular_file', 'a.ts', 'entry changed after admission');
    };
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    let reserved = 0;
    const first = await engine.search({ query: 'first' }, { onUsage: (usage) => { reserved = usage.inputTokens; } });
    assert.ok('error' in first.outcome);
    assert.ok(reserved > 0);
    client.calls = 0;
    const results = await engine.searchMany([{ query: 'first' }, { query: 'second' }], { max_input_tokens: reserved });
    assert.equal(client.calls, 1);
    assert.ok('report' in results[1]!.outcome);
    assert.ok(results[1]!.outcome.report.stop_reasons.includes('SCAN_CAP_REACHED'));
  } finally { space.cleanup(); }
});

test('one profiler measures the whole multiquestion call', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const profile = new SearchProfiler();
    const results = await createSearchEngine({ configuration: space.loaded, provider: provider() }).searchMany(
      [{ query: 'first' }, { query: 'second' }], { profile },
    );
    assert.equal(results.length, 2);
    assert.ok(profile.snapshot().stages.search !== undefined);
    assert.ok(profile.snapshot().counters['serializedQuestions']! >= 2);
  } finally { space.cleanup(); }
});
