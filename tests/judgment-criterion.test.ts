import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvaluationBatch } from '../src/evaluation/contracts.ts';
import { CRITERION_VERSION, RELEVANCE_CRITERION, buildRequestPayload } from '../src/evaluation/jev.ts';
import { serializeOpenRouterBatch } from '../src/evaluation/openrouter.ts';
import { serializeGatewayBatch } from '../src/evaluation/vercel-gateway.ts';

const BATCH: EvaluationBatch = {
  query: 'Where is a cached user invalidated?',
  layout: 'layout-a-1',
  items: [{ id: 'f-1', path: 'src/cache.ts', startLine: 7, endLine: 9, text: 'export function invalidateUser() {}\n', label: null }],
};
const FOCUSED = { version: 'focused-test-1', text: 'Judge only whether this excerpt is about caching.' };

test('a batch without a judgment criterion keeps the relevance criterion on every transport', () => {
  const direct = buildRequestPayload(BATCH, 'jev-1.13.0');
  assert.equal(direct.state.criterion, RELEVANCE_CRITERION);
  assert.equal(direct.state.criterion_version, CRITERION_VERSION);
  assert.equal(direct.questions['f-1']?.criteria?.true, RELEVANCE_CRITERION);
  const gateway = JSON.parse(serializeGatewayBatch(BATCH)) as { state: Record<string, string>; questions: Record<string, { criteria: { true: string } }> };
  assert.equal(gateway.state['criterion_version'], CRITERION_VERSION);
  assert.equal(gateway.questions['f-1']?.criteria.true, RELEVANCE_CRITERION);
});

test('an experimental judgment criterion replaces the criterion text and version in state and questions', () => {
  const batch = { ...BATCH, criterion: FOCUSED };
  const direct = buildRequestPayload(batch, 'jev-1.13.0');
  assert.equal(direct.state.criterion, FOCUSED.text);
  assert.equal(direct.state.criterion_version, FOCUSED.version);
  assert.equal(direct.questions['f-1']?.criteria?.true, FOCUSED.text);
  const gateway = serializeGatewayBatch(batch);
  assert.ok(gateway.includes(FOCUSED.version) && !gateway.includes(RELEVANCE_CRITERION));
  const openrouter = JSON.parse(serializeOpenRouterBatch(batch)) as { questions: Record<string, { criteria: { true: string; false: string } }> };
  assert.equal(openrouter.questions['f-1']?.criteria.true, FOCUSED.text);
  assert.ok(!openrouter.questions['f-1']?.criteria.false.includes('concrete evidence'));
  assert.notEqual(serializeGatewayBatch(batch), serializeGatewayBatch(BATCH));
});
