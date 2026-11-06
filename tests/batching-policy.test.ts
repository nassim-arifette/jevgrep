import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBatches, buildBatchesAsync } from '../src/planning.ts';
import type { EvaluationBatch } from '../src/evaluation/contracts.ts';
import { buildRequestPayload } from '../src/evaluation/jev.ts';
import { batchLimits, fitsSerializedBatch, measureSerializedBatch, scoreCachePolicy } from '../src/evaluation/policy.ts';
import { serializeGatewayBatch } from '../src/evaluation/vercel-gateway.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import type { PreparedFragment } from '../src/source/chunker.ts';
import { buildInitialConfiguration } from '../src/init.ts';

function fragment(index: number, text = 'export const value = 1;'): PreparedFragment {
  const path = `src/file-${String(index).padStart(3, '0')}.ts`;
  return { id: path, path, text, startLine: 1, endLine: 1, byteStart: 0, byteEnd: Buffer.byteLength(text),
    byteCount: Buffer.byteLength(text), tokenCount: countReferenceTokens(text), sha256: 'snapshot',
    chunker: 'test', classification: 'line-window' };
}
const serializeDirect = (batch: EvaluationBatch): string => JSON.stringify(buildRequestPayload(batch, 'jev-1.13.0'));

test('small questions pack past eight with deterministic ordering and a secondary question cap', () => {
  const fragments = Array.from({ length: 70 }, (_, i) => fragment(i));
  const batches = buildBatches([...fragments].reverse(), 'Find value');
  assert.deepEqual(batches.map((batch) => batch.items.length), [64, 6]);
  assert.deepEqual(batches.flatMap((batch) => batch.items.map((item) => item.id)), fragments.map((item) => item.id));
});

test('token-sized batches use different budgets for direct TypeSafe and Gateway', () => {
  const fragments = Array.from({ length: 32 }, (_, i) => fragment(i, 'value '.repeat(1_000)));
  const direct = buildBatches(fragments, 'Find value', { serialize: serializeDirect });
  const gatewayLimits = batchLimits('vercel-ai-gateway');
  const gateway = buildBatches(fragments, 'Find value', { limits: gatewayLimits, serialize: serializeGatewayBatch });
  assert.equal(direct.length, 1);
  assert.equal(gateway.length, 2);
  assert.ok(gateway.every((batch) => fitsSerializedBatch(serializeGatewayBatch(batch), gatewayLimits)));
  assert.ok(!fitsSerializedBatch(serializeGatewayBatch({ query: 'Find value', items: fragments }), gatewayLimits));
});

test('wire bytes, the full query and individual question limits constrain batching', () => {
  const items = [fragment(0), fragment(1)];
  const query = 'Find value';
  const oneBytes = Buffer.byteLength(serializeDirect({ query, items: items.slice(0, 1) }));
  const limits = { ...batchLimits(), maxRequestBytes: oneBytes };
  assert.deepEqual(buildBatches(items, query, { serialize: serializeDirect, limits }).map((b) => b.items.length), [1, 1]);
  assert.throws(() => buildBatches(items, 'query '.repeat(30_000)), /one question exceeds/);
  const body = serializeDirect({ query, items });
  assert.equal(fitsSerializedBatch(body, { ...batchLimits(), perQuestionTokens: 10 }), false);
});

test('premeasured singleton questions and final batch costs keep exact payload limits', () => {
  const fragments = Array.from({ length: 4 }, (_, i) => fragment(i));
  const query = 'Find value';
  const limits = batchLimits();
  const singletons = new Map(fragments.map((item) => [item.id,
    measureSerializedBatch(serializeDirect({ query, items: [item] }), limits)]));
  let serializations = 0;
  const measurements: { tokens: number | null; bytes: number }[] = [];
  const batches = buildBatches(fragments, query, {
    serialize: (batch) => { serializations++; return serializeDirect(batch); },
    limits, singletonMeasures: singletons,
    onBatchMeasure: (_batch, cost) => measurements.push(cost),
  });
  assert.deepEqual(batches.map((batch) => batch.items.length), [4]);
  assert.equal(serializations, 2, 'one serialization reads the shared state, one measures the final batch exactly');
  const body = serializeDirect(batches[0]!);
  assert.deepEqual(measurements, [{ tokens: countReferenceTokens(body), bytes: Buffer.byteLength(body), fits: true }]);
});

test('batching tokenizes the wire body once per batch, not once per added question', () => {
  const fragments = Array.from({ length: 400 }, (_, i) => fragment(i, `const value${i} = ${'x'.repeat(200)};`));
  const query = 'Find value';
  const limits = batchLimits();
  let serializations = 0;
  let measured = 0;
  const batches = buildBatches(fragments, query, {
    serialize: (batch) => { serializations++; return serializeDirect(batch); }, limits,
    onBatchMeasure: (batch, measure) => { measured++; assert.ok(measure.fits); assert.equal(measure.tokens, countReferenceTokens(serializeDirect(batch))); },
  });
  assert.ok(batches.length >= 7 && batches.length <= 8, `${batches.length} batches`);
  assert.equal(measured, batches.length);
  assert.ok(batches.every((batch) => fitsSerializedBatch(serializeDirect(batch), limits)));
  assert.deepEqual(batches.flatMap((batch) => batch.items.map((item) => item.id)), fragments.map((item) => item.id));
  // singletons (400) + state (1) + final measure per batch + a few exact checks near each limit
  assert.ok(serializations < 400 + 1 + batches.length * 6, `${serializations} serializations`);
});

test('new direct profiles are pinned; rolling reuse is bounded, optional and adapter-specific', () => {
  assert.equal(buildInitialConfiguration('C:/example', 'typesafe').provider.model, 'jev-1.13.0');
  const cache = { enabled: true, ttl_seconds: 604_800 };
  assert.deepEqual(scoreCachePolicy('typesafe-direct', 'jev-1.13.0', cache), { mode: 'pinned', ttlSeconds: 604_800 });
  assert.deepEqual(scoreCachePolicy('vercel-ai-gateway', 'typesafe-ai/jev', cache), { mode: 'rolling', ttlSeconds: 900 });
  assert.equal(scoreCachePolicy('vercel-ai-gateway', 'jev-1.13.0', cache).mode, 'disabled');
  assert.equal(scoreCachePolicy('typesafe-direct', 'typesafe-ai/jev', cache).mode, 'disabled');
  assert.equal(scoreCachePolicy('vercel-ai-gateway', 'typesafe-ai/jev', { ...cache, rolling_ttl_seconds: 0 }).mode, 'disabled');
  assert.equal(scoreCachePolicy('vercel-ai-gateway', 'typesafe-ai/jev', { ...cache, enabled: false }).mode, 'disabled');
});

test('batches built with pool workers are the batches built on the calling thread', () => {
  const fragments = Array.from({ length: 600 }, (_, i) => fragment(i, `const value${i} = "${'word '.repeat(60 + (i % 37))}";`));
  const query = 'Find value';
  const limits = batchLimits();
  const sequential = buildBatches(fragments, query, { serialize: serializeDirect, limits, threads: 0 });
  const pooled = buildBatches(fragments, query, { serialize: serializeDirect, limits, threads: 2 });
  assert.deepEqual(pooled.map((batch) => batch.items.map((item) => item.id)), sequential.map((batch) => batch.items.map((item) => item.id)));
  assert.ok(sequential.length > 5);
  assert.ok(sequential.every((batch) => fitsSerializedBatch(serializeDirect(batch), limits)));
});

test('batches built asynchronously on the pool are the batches built synchronously, and an abort stops the wait', async () => {
  const fragments = Array.from({ length: 600 }, (_, i) => fragment(i, `const value${i} = "${'word '.repeat(60 + (i % 37))}";`));
  const query = 'Find value';
  const limits = batchLimits();
  const sequential = buildBatches(fragments, query, { serialize: serializeDirect, limits, threads: 0 });
  const asynchronous = await buildBatchesAsync(fragments, query, { serialize: serializeDirect, limits, threads: 2 });
  assert.deepEqual(asynchronous.map((batch) => batch.items.map((item) => item.id)), sequential.map((batch) => batch.items.map((item) => item.id)));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildBatchesAsync(fragments, query, { serialize: serializeDirect, limits, threads: 2, signal: controller.signal }), /aborted/);
});
