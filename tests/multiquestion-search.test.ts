import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import { RequestValidationError } from '../src/engine.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { ManualClock } from '../src/testing/manual-clock.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import type { SearchResult } from '../src/contracts.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

function provider(): ProviderClient & { calls: number } {
  return {
    model: 'jev-1.13.0', calls: 0,
    async evaluateBatch(batch) {
      this.calls += 1;
      return { scores: new Map(batch.items.map((item) => [item.id, item.path === 'a.ts' ? 0.9 : 0.1])), invalid: [],
        usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
        transmittedBytes: 0, requestId: null };
    },
  };
}

const asResult = (outcome: unknown): SearchResult => {
  assert.ok(typeof outcome === 'object' && outcome !== null && 'excerpts' in outcome, JSON.stringify(outcome));
  return outcome as SearchResult;
};

test('several questions get separate results and pay for their own evaluations', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' } });
  const client = provider();
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    const outcomes = await engine.searchMany([{ query: 'first?' }, { query: 'second?' }, { query: 'first?', scope: ['b.ts'] }]);
    const results = outcomes.map(({ outcome }) => asResult(outcome));
    assert.equal(new Set(outcomes.map(({ searchId }) => searchId)).size, 3);
    assert.deepEqual(results.map((result) => result.status), ['complete', 'complete', 'complete']);
    assert.deepEqual(results[0]?.excerpts.map((excerpt) => excerpt.path), ['a.ts']);
    assert.deepEqual(results[2]?.report.scope, ['b.ts']);
    assert.equal(results[0]?.report.usage.provider_request_attempts, 1);
    assert.equal(results[1]?.report.usage.provider_request_attempts, 1, 'shared preparation does not make a question free');
    assert.equal(results[2]?.report.fragments.cache_reused, 1, 'the same question reuses its scores across scopes');
    assert.equal(client.calls, 2);
  } finally { space.cleanup(); }
});

test('an identical scope is prepared once; a different scope is prepared separately', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' } });
  try {
    const lookups = (engine: ReturnType<typeof createSearchEngine>): number =>
      engine.preparationCache.stats.hits + engine.preparationCache.stats.misses;
    const single = createSearchEngine({ configuration: space.loaded, provider: provider() });
    await single.search({ query: 'one?' });
    const narrow = createSearchEngine({ configuration: space.loaded, provider: provider() });
    await narrow.search({ query: 'one?', scope: ['a.ts'] });
    const many = createSearchEngine({ configuration: space.loaded, provider: provider() });
    await many.searchMany([{ query: 'one?' }, { query: 'two?' }, { query: 'three?' }, { query: 'four?', scope: ['a.ts'] }]);
    assert.equal(lookups(many), lookups(single) + lookups(narrow));
  } finally { space.cleanup(); }
});

test('a file edited between questions is reported as changed rather than served stale', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const client = provider();
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    let edited = false;
    const original = client.evaluateBatch.bind(client);
    client.evaluateBatch = async (batch, ...rest) => {
      const answer = await original(batch, ...rest);
      if (client.calls === 1 && !edited) { edited = true; space.write('a.ts', 'export const a = 2;\n'); }
      return answer;
    };
    const [first, second] = (await engine.searchMany([{ query: 'one?' }, { query: 'two?' }])).map(({ outcome }) => asResult(outcome));
    assert.equal(first?.report.files.changed_before_return, 1);
    assert.equal(second?.report.files.changed_before_return, 1);
    assert.equal(second?.excerpts.length, 0);
  } finally { space.cleanup(); }
});

test('a function that only moved in its file keeps its cached score', async () => {
  const fn = (name: string): string => `export function ${name}(input) {\n${Array.from({ length: 60 },
    (_, i) => `  const v${String(i)} = input.${name}${String(i)} ?? compute${String(i)}(input);`).join('\n')}\n  return v0;\n}\n`;
  const body = `${fn('alpha')}\n${fn('beta')}`;
  const space = createWorkspace({ files: { 'a.ts': body } });
  try {
    const client = provider();
    const first = asResult((await createSearchEngine({ configuration: space.loaded, provider: client }).search({ query: 'where?' })).outcome);
    assert.equal(first.report.fragments.cache_reused, 0);
    space.write('a.ts', `${fn('added')}\n${body}`);
    const second = asResult((await createSearchEngine({ configuration: space.loaded, provider: client }).search({ query: 'where?' })).outcome);
    assert.equal(second.report.fragments.cache_reused, 2, 'the two moved functions are not judged again');
    // Adjacent selected units are delivered as one range; it must end at the real, shifted last line.
    assert.deepEqual(second.excerpts.map((excerpt) => [excerpt.start_line, excerpt.end_line]), [[1, 191]],
      'returned provenance keeps the real line numbers');
  } finally { space.cleanup(); }
});

test('all multiquestion inputs are validated before any provider work', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const client = provider();
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    for (const questions of [[], Array.from({ length: 17 }, () => ({ query: 'q' })), [{ query: 'valid' }, { query: 1 }], [{ query: 'q', model: 'override' }]]) {
      await assert.rejects(engine.searchMany(questions), RequestValidationError);
    }
    assert.equal(client.calls, 0);
  } finally { space.cleanup(); }
});

test('aggregate input spending prevents a later question from dispatching', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const client = provider();
    const evaluate = client.evaluateBatch.bind(client);
    client.evaluateBatch = async (...args) => ({ ...await evaluate(...args), usage: { inputTokens: 1_000, outputTokens: 0 } });
    const engine = createSearchEngine({ configuration: space.loaded, provider: client });
    const results = (await engine.searchMany([{ query: 'first' }, { query: 'second' }], { max_input_tokens: 1_000 })).map(({ outcome }) => asResult(outcome));
    assert.equal(client.calls, 1);
    assert.equal(results[1]?.report.usage.provider_request_attempts, 0);
    assert.ok(results[1]?.report.stop_reasons.includes('SCAN_CAP_REACHED'));
    assert.equal(results[1]?.status, 'partial');
  } finally { space.cleanup(); }
});

test('aggregate deadline is shared across all questions', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const clock = new ManualClock();
    const client = provider();
    const evaluate = client.evaluateBatch.bind(client);
    client.evaluateBatch = async (...args) => { const result = await evaluate(...args); clock.advanceBy(11); return result; };
    const results = (await createSearchEngine({ configuration: space.loaded, provider: client, clock }).searchMany(
      [{ query: 'first' }, { query: 'second' }], { max_search_ms: 10 },
    )).map(({ outcome }) => asResult(outcome));
    assert.equal(client.calls, 1);
    assert.ok(results[1]?.report.stop_reasons.includes('DEADLINE'));
    assert.equal(results[1]?.report.usage.provider_request_attempts, 0);
  } finally { space.cleanup(); }
});

test('aggregate response budget covers the serialized results wrapper', async () => {
  const space = createWorkspace({ files: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`${index}.ts`, `export const a${index} = ${index};\n`])) });
  try {
    const results = await createSearchEngine({ configuration: space.loaded, provider: provider() }).searchMany(
      [{ query: 'first' }, { query: 'second' }], { max_context_tokens: 3_000 },
    );
    assert.ok(results.every(({ outcome }) => 'report' in outcome));
    assert.ok(countReferenceTokens(JSON.stringify({ results: results.map(({ outcome }) => outcome) })) <= 3_000);
  } finally { space.cleanup(); }
});
