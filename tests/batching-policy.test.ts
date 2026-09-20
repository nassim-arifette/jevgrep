import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBatches } from '../src/engine.ts';
import { buildRequestPayload, type EvaluationBatch } from '../src/evaluation/jev.ts';
import { batchLimits, fitsSerializedBatch, scoreCachePolicy } from '../src/evaluation/policy.ts';
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
