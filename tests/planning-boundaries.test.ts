import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import { planScan } from '../src/planning.ts';
import { buildRequestPayload } from '../src/evaluation/jev.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import type { PreparedFragment } from '../src/source/chunker.ts';
import { ManualClock } from '../src/testing/manual-clock.ts';
import { createWorkspace } from './helpers/search-workspace.ts';
import { replayPool } from '../scripts/bench/replay.ts';
import type { CandidatePool } from '../src/response/candidate-pool.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';

function client(): ProviderClient & { calls: number } {
  return { model: 'jev-1.13.0', calls: 0, async evaluateBatch(batch) {
    this.calls += 1;
    return { scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
      usage: { inputTokens: 1, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 0, requestId: null };
  } };
}

for (const sizes of [[10], [6, 4]]) {
  test(`truncating the last of batches ${sizes.join(',')} records a scan cap`, () => {
    const fragments: PreparedFragment[] = Array.from({ length: 10 }, (_, index) => ({
      id: String(index), path: `${index}.ts`, text: 'x', startLine: 1, endLine: 1,
      byteStart: 0, byteEnd: 1, byteCount: 1, tokenCount: 1, sha256: 'hash', chunker: 'test', classification: 'line-window',
    }));
    let offset = 0;
    const batches = sizes.map((size) => { const items = fragments.slice(offset, offset + size); offset += size; return { query: 'q', items }; });
    const plan = planScan(fragments, 'q', {
      model: 'jev-1.13.0', batches, batchCost: (batch) => ({ tokens: batch.items.length, bytes: batch.items.length }),
      enabledCaps: { estimated_input_tokens: 8 }, allowPartial: true, requireFit: true,
      preparedBytes: 10, candidateFiles: 10, preparedFragments: 10, pricePerMillionInputTokens: null,
    });
    assert.equal(plan.capReached, true);
    assert.equal(plan.rejected, false);
    assert.equal(plan.batches.flatMap((batch) => batch.items).length, 8);
  });
}

test('a partial single batch reports the cap and evaluates priority candidates', async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i}.ts`, `export const unrelated${i} = ${i};\n`]));
  files['z-session.ts'] = 'export function invalidateSession() { return true; }\n';
  const space = createWorkspace({ files });
  try {
    const provider = client();
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const outcome = (await engine.search({ query: 'invalidate session', max_input_tokens: 250 })).outcome;
    assert.ok('report' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.status, 'partial');
    assert.ok(outcome.report.fragments.remote_evaluated > 0);
    assert.ok(outcome.report.fragments.not_evaluated > 0);
    assert.ok(outcome.report.stop_reasons.includes('SCAN_CAP_REACHED'));
    assert.ok(!outcome.report.stop_reasons.includes('PROVIDER_UNAVAILABLE'));
    assert.ok(outcome.excerpts.some((excerpt) => excerpt.path === 'z-session.ts'));
  } finally { space.cleanup(); }
});

test('a deadline during token planning returns a coverage report with no provider failure', async () => {
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' } });
  try {
    const clock = new ManualClock();
    const provider = client();
    provider.serializeBatch = (batch) => {
      clock.advanceBy(space.loaded.config.search.deadline_ms + 1);
      return JSON.stringify(buildRequestPayload(batch, provider.model));
    };
    const outcome = (await createSearchEngine({ configuration: space.loaded, provider, clock }).search({ query: 'a' })).outcome;
    assert.ok('report' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.report.inventory_complete, true);
    assert.equal(outcome.report.fragments.total, 1);
    assert.equal(outcome.report.fragments.not_evaluated, 1);
    assert.deepEqual(outcome.report.stop_reasons, ['DEADLINE']);
    assert.equal(outcome.report.preflight.estimated_first_attempt_tokens, null);
    assert.equal(provider.calls, 0);
  } finally { space.cleanup(); }
});

test('cache lookup yields to cancellation on a warm corpus and retains known scores at a deadline', async (t) => {
  const space = createWorkspace({ files: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${i}.ts`, `export const a${i} = ${i};\n`])) });
  try {
    const clock = new ManualClock();
    const provider = client();
    const engine = createSearchEngine({ configuration: space.loaded, provider, clock });
    let reads = 0;
    t.mock.method(engine.cache, 'read', () => {
      reads += 1;
      if (reads === 10) clock.advanceBy(space.loaded.config.search.deadline_ms + 1);
      return 0.9;
    });
    const outcome = (await engine.search({ query: 'a' })).outcome;
    assert.ok('report' in outcome);
    assert.equal(outcome.report.fragments.cache_reused, 10);
    assert.equal(outcome.report.fragments.not_evaluated, 60);
    assert.deepEqual(outcome.report.stop_reasons, ['DEADLINE']);
    assert.equal(provider.calls, 0);
  } finally { space.cleanup(); }
});

test('actual-report refill returns more evidence at a fixed budget without new provider work', async () => {
  const files = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`${i}.ts`, `export const value${i} = ${i};\n`]));
  const space = createWorkspace({ files });
  try {
    const provider = client();
    let pool: CandidatePool | undefined;
    const answer = await createSearchEngine({ configuration: space.loaded, provider }).search(
      { query: 'values', max_context_tokens: 1_400 }, { onCandidatePool: (captured) => { pool = captured; } },
    );
    assert.ok(pool !== undefined);
    assert.ok('report' in answer.outcome);
    const previous = replayPool(pool, files, { policy: 'relevance', refill: false });
    const current = replayPool(pool, files, { policy: 'relevance' });
    assert.ok(answer.outcome.report.fragments.represented_in_response > previous.result.report.fragments.represented_in_response);
    assert.deepEqual(current.result.excerpts, answer.outcome.excerpts);
    assert.ok(countReferenceTokens(JSON.stringify(answer.outcome)) <= 1_400);
    assert.equal(provider.calls, 1);
  } finally { space.cleanup(); }
});
