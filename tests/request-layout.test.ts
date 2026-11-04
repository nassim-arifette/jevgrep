import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { EvaluationBatch } from '../src/evaluation/contracts.ts';
import { CRITERION_REFERENCE, LAYOUT_VERSION, RELEVANCE_CRITERION, buildRequestPayload, questionInstructions } from '../src/evaluation/jev.ts';
import { serializeOpenRouterBatch } from '../src/evaluation/openrouter.ts';
import { serializeGatewayBatch } from '../src/evaluation/vercel-gateway.ts';
import { planChunks } from '../scripts/bench/layouts.ts';

const BATCH: EvaluationBatch = {
  query: 'Where is a cached user invalidated?',
  items: [
    { id: 'f-1', path: 'src/cache.ts', startLine: 7, endLine: 9, text: 'export function invalidateUser() {}\n', label: null },
    { id: 'f-2', path: 'src/a.py', startLine: 1, endLine: 2, text: 'def f():\n  pass\n', label: 'def f' },
  ],
};
const FOCUSED = { version: 'focused-test-1', text: 'Judge only whether this excerpt is about caching.' };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const serializers = {
  direct: (batch: EvaluationBatch) => JSON.stringify(buildRequestPayload(batch, 'jev-1.13.0')),
  gateway: serializeGatewayBatch,
  openrouter: serializeOpenRouterBatch,
};

test('layout-a-1 still sends the bytes it sent before layouts existed; no field means the production layout', () => {
  // SHA-256 of the payloads serialized before the layout seam was added.
  const before = {
    direct: 'ce7af1f5e97366155a2cd250444f0252f62e920159a4a673e37633d4f3724ca8',
    gateway: 'b4cb7db83d0f01bc1a054fd7127dc1179a44f95fc4656d2751907391838e0ce0',
    openrouter: '57c5d73026ed0083907d4f8364e3a1d18fada7c4e6bac370cd46e9268bc74c65',
  };
  for (const [name, serialize] of Object.entries(serializers)) {
    assert.equal(hash(serialize({ ...BATCH, layout: 'layout-a-1' })), before[name as keyof typeof before], name);
    assert.equal(serialize({ ...BATCH, layout: LAYOUT_VERSION }), serialize(BATCH), name);
  }
  assert.equal(hash(serializeGatewayBatch({ ...BATCH, layout: 'layout-a-1', criterion: FOCUSED })),
    '6685c982a3e99bd1ee6453c8034e466923f83ce85707c811a9c7965bd349c1ab');
});

test('compact layouts state the criterion once, are versioned and keep one question per excerpt', () => {
  for (const [name, serialize] of Object.entries(serializers)) {
    const full = serialize(BATCH);
    for (const layout of ['layout-compact-state-1', 'layout-compact-ref-1'] as const) {
      const body = serialize({ ...BATCH, layout });
      const payload = JSON.parse(body) as { state: Record<string, string>; questions: Record<string, { instructions: string; criteria?: Record<string, string> }> };
      assert.equal(body.split(RELEVANCE_CRITERION).length - 1, 1, `${name} ${layout}`);
      assert.equal(payload.state['criterion'], RELEVANCE_CRITERION);
      assert.equal(payload.state['layout'], layout);
      assert.deepEqual(Object.keys(payload.questions), ['f-1', 'f-2']);
      assert.ok(payload.questions['f-2']!.instructions.includes('Structure: def f'));
      const criteria = payload.questions['f-1']!.criteria;
      if (layout === 'layout-compact-state-1') assert.equal(criteria, undefined);
      else assert.equal(criteria?.['true'], CRITERION_REFERENCE.true);
      assert.ok(Buffer.byteLength(body) < Buffer.byteLength(full));
    }
  }
  const openrouter = JSON.parse(serializeOpenRouterBatch({ ...BATCH, layout: 'layout-compact-ref-1' })) as { questions: Record<string, { criteria: Record<string, string> }> };
  assert.equal(openrouter.questions['f-1']?.criteria['false'], CRITERION_REFERENCE.false);
});

test('every layout is judged on the same deterministic chunks, packed with the largest layout', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ ...BATCH.items[0]!, id: `f-${String(index)}`, text: 'x'.repeat(40) }));
  const sizes: number[] = [];
  const chunks = planChunks(BATCH.query, items, (batch) => { sizes.push(batch.items.length); return JSON.stringify(batch); }, (body) => body.length < 400);
  assert.deepEqual(chunks.map((chunk) => chunk.map((item) => item.id)).flat(), items.map((item) => item.id));
  assert.ok(chunks.length > 1 && chunks.every((chunk) => chunk.length >= 1));
  assert.deepEqual(planChunks(BATCH.query, items, (batch) => JSON.stringify(batch), (body) => body.length < 400), chunks);
  assert.deepEqual(planChunks(BATCH.query, [items[0]!], () => 'x'.repeat(1_000), () => false), [[items[0]]]);
  assert.ok(sizes.length > 0);
});

test('location-independent layouts drop the line range, or the path and line range, and nothing else', () => {
  const item = BATCH.items[0]!;
  const header = (layout: 'layout-a-nolines-1' | 'layout-a-noloc-1') => questionInstructions(item, layout);
  assert.ok(!header('layout-a-nolines-1').includes('Lines:'));
  assert.ok(header('layout-a-nolines-1').startsWith(`File: ${item.path}\n`));
  assert.ok(!header('layout-a-noloc-1').includes('File:'));
  assert.ok(!header('layout-a-noloc-1').includes('Lines:'));
  for (const layout of ['layout-a-nolines-1', 'layout-a-noloc-1'] as const) {
    assert.ok(header(layout).endsWith(item.text));
    for (const [name, serialize] of Object.entries(serializers)) {
      const body = serialize({ ...BATCH, layout });
      assert.ok(!body.includes('Lines:'), `${name} ${layout}`);
      assert.equal((JSON.parse(body) as { state: Record<string, string> }).state['layout'], layout, `${name} ${layout}`);
    }
  }
});
