import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError, type EvaluationBatch } from '../src/evaluation/contracts.ts';
import { DecisionGatewayAdapter, type DecisionGatewayOptions } from '../src/evaluation/decision-gateway.ts';
import type { TransportRequest, TransportResponse } from '../src/evaluation/http.ts';

const batch: EvaluationBatch = { query: 'Find authentication', layout: 'layout-a-1', items: [
  { id: 'first', path: 'a.ts', startLine: 1, endLine: 1, text: 'authenticate();', label: null },
  { id: 'second', path: 'b.ts', startLine: 1, endLine: 1, text: 'other();', label: null },
] };
const answer = '{"type":"noul","noul":0.9}';
const result = { model: 'jev-1.13.0', answers: { first: { type: 'noul', noul: 0.9 }, second: { type: 'noul', noul: 0.2 } },
  usage: { input_tokens: 100, output_tokens: 0 } };
const cloudflareBase = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}`;
const providers: readonly DecisionGatewayOptions[] = [
  { adapter: 'cloudflare', baseUrl: cloudflareBase, model: 'typesafe/jev', apiKey: 'synthetic-secret' },
  { adapter: 'litellm', baseUrl: 'https://proxy.example/gateway', model: 'jev-1.13.0', apiKey: 'synthetic-secret' },
  { adapter: 'portkey', baseUrl: 'https://api.portkey.ai', model: '@typesafe-prod/jev-1.13.0', apiKey: 'synthetic-secret' },
];

for (const options of providers) {
  test(`${options.adapter} sends the documented endpoint, credentials and exactly accounted payload once`, async () => {
    const requests: TransportRequest[] = [];
    const adapter = new DecisionGatewayAdapter({ ...options, transport: async (request) => {
      requests.push(request); return { status: 200, headers: { 'x-request-id': 'synthetic-id' }, text: JSON.stringify(result) };
    } });
    const body = adapter.serializeBatch(batch);
    const evaluation = await adapter.evaluateBatch(batch, undefined, body);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.url, options.adapter === 'cloudflare' ? `${cloudflareBase}/ai/run`
      : options.adapter === 'litellm' ? 'https://proxy.example/gateway/typesafe/v1/systemone' : 'https://api.portkey.ai/v1/decisions');
    assert.equal(request.method, 'POST'); assert.equal(request.body, body);
    assert.equal(evaluation.transmittedBytes, Buffer.byteLength(body));
    const payload = JSON.parse(body);
    assert.equal(payload.model, options.model);
    const input = options.adapter === 'cloudflare' ? payload.input : payload;
    assert.equal(input.state.search_question, batch.query);
    assert.deepEqual(Object.keys(input.questions), ['first', 'second']);
    assert.equal(input.questions.first.type, 'noul');
    assert.ok(input.questions.first.instructions.includes('authenticate();'));
    assert.equal(request.headers[options.adapter === 'portkey' ? 'x-portkey-api-key' : 'authorization'],
      options.adapter === 'portkey' ? options.apiKey : `Bearer ${options.apiKey}`);
    assert.equal(request.headers[options.adapter === 'portkey' ? 'authorization' : 'x-portkey-api-key'], undefined);
    assert.equal(evaluation.scores.get('first'), 0.9); assert.equal(evaluation.scores.get('second'), 0.2);
    assert.equal(evaluation.returnedModel, 'jev-1.13.0'); assert.equal(evaluation.usage.inputTokens, 100);
    assert.equal(evaluation.usage.outputTokens, 0);
  });

  test(`${options.adapter} keeps partial validity and unknown usage without manufacturing zeroes`, async () => {
    const adapter = new DecisionGatewayAdapter({ ...options, transport: async () => ({ status: 200, headers: {},
      text: JSON.stringify({ answers: { first: { type: 'noul', noul: 0.9 }, second: { type: 'noul', noul: 'bad' } } }) }) });
    const evaluation = await adapter.evaluateBatch(batch);
    assert.equal(evaluation.scores.get('first'), 0.9); assert.equal(evaluation.scores.has('second'), false);
    assert.deepEqual(evaluation.invalid, [{ id: 'second', reason: 'wrong_type' }]);
    assert.deepEqual(evaluation.usage, { inputTokens: null, outputTokens: null });
  });

  test(`${options.adapter} normalizes failures without leaking response bodies, following redirects or retrying`, async () => {
    for (const response of [new Error('synthetic-secret'),
      ...[401, 402, 429, 500, 307].map((status): TransportResponse => ({ status,
        headers: { location: 'https://untrusted.example', 'retry-after': '2' }, text: 'synthetic-secret' })),
      { status: 200, headers: {}, text: 'synthetic-secret' }]) {
      let calls = 0;
      const adapter = new DecisionGatewayAdapter({ ...options, transport: async () => {
        calls++; if (response instanceof Error) throw response; return response;
      } });
      await assert.rejects(adapter.evaluateBatch(batch), (error: unknown) => {
        assert.ok(error instanceof ProviderError); assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
        assert.ok(!error.message.includes('synthetic-secret')); return true;
      });
      assert.equal(calls, 1);
    }
  });

  test(`${options.adapter} production transport is bounded, does not redirect, and honors cancellation`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++; assert.equal(init.redirect, 'manual'); return Response.json(result);
    });
    const adapter = new DecisionGatewayAdapter(options);
    assert.equal((await adapter.evaluateBatch(batch)).scores.get('first'), 0.9);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.evaluateBatch(batch, controller.signal), { name: 'AbortError' });
    await assert.rejects(adapter.evaluateBatch({ ...batch, items: [] }), ProviderError);
    assert.equal(calls, 1);
  });
}

test('Cloudflare unwraps successful envelopes and preserves valid neighbors and usage', async () => {
  const adapter = new DecisionGatewayAdapter({ ...providers[0]!, transport: async () => ({ status: 200, headers: {},
    text: JSON.stringify({ success: true, result: { ...result, answers: { ...result.answers, second: { type: 'noul', noul: -1 } } } }) }) });
  const evaluation = await adapter.evaluateBatch(batch);
  assert.equal(evaluation.scores.get('first'), 0.9); assert.equal(evaluation.scores.has('second'), false);
  assert.equal(evaluation.usage.inputTokens, 100); assert.equal(evaluation.returnedModel, result.model);
});

test('Cloudflare refuses failed, missing and malformed envelope results', async () => {
  for (const envelope of [{ success: false, result, errors: ['synthetic-secret'] }, { success: true },
    { result }, { success: true, result: null }, { success: true, result: [] }]) {
    const adapter = new DecisionGatewayAdapter({ ...providers[0]!, transport: async () => ({ status: 200, headers: {}, text: JSON.stringify(envelope) }) });
    await assert.rejects(adapter.evaluateBatch(batch), (error: unknown) => error instanceof ProviderError
      && error.code === 'INVALID_PROVIDER_RESPONSE' && !error.message.includes('synthetic-secret'));
  }
});

test('Cloudflare inspects duplicate keys inside result before normalization, including escaped keys', async () => {
  for (const wrapped of [false, true]) {
    const payloads = [
      { body: `{"answers":{"first":${answer},"\\u0066irst":${answer},"second":${answer}}}`, scores: 1, usage: null },
      { body: `{"answers":{"first":{"type":"noul","noul":0.1,"noul":0.9},"second":${answer}}}`, scores: 1, usage: null },
      { body: `{"answers":{"first":${answer}},"answers":{"first":${answer},"second":${answer}}}`, scores: 0, usage: null },
      { body: `{"answers":{"first":${answer},"second":${answer}},"usage":{"input_tokens":1,"input_tokens":2}}`, scores: 2, usage: null },
      { body: `{"answers":{"first":${answer},"second":${answer}},"metadata":{"answers":{"first":0,"first":1}},"usage":{"input_tokens":2}}`, scores: 2, usage: 2 },
    ];
    for (const payload of payloads) {
      const text = wrapped ? `{"success":true,"result":${payload.body}}` : payload.body;
      const adapter = new DecisionGatewayAdapter({ ...providers[0]!, transport: async () => ({ status: 200, headers: {}, text }) });
      const evaluation = await adapter.evaluateBatch(batch);
      assert.equal(evaluation.scores.size, payload.scores); assert.equal(evaluation.usage.inputTokens, payload.usage);
    }
  }
  for (const text of [`{"success":true,"success":true,"result":${JSON.stringify(result)}}`,
    `{"success":true,"result":{},"\\u0072esult":${JSON.stringify(result)}}`]) {
    const adapter = new DecisionGatewayAdapter({ ...providers[0]!, transport: async () => ({ status: 200, headers: {}, text }) });
    const evaluation = await adapter.evaluateBatch(batch);
    assert.equal(evaluation.scores.size, 0); assert.equal(evaluation.usage.inputTokens, null);
  }
});
