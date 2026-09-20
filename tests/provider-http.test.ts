import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedFetch, MAX_PROVIDER_RESPONSE_BYTES } from '../src/evaluation/http.ts';
import { JevAdapter, ProviderError, duplicateAnswerKeys, type EvaluationBatch } from '../src/evaluation/jev.ts';
import { VercelGatewayAdapter, VERCEL_JEV_MODEL } from '../src/evaluation/vercel-gateway.ts';
import { createSearchEngine } from '../src/engine.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

const batch: EvaluationBatch = { query: 'q "é"', items: [{ id: 'first', path: 'a.ts', startLine: 1, endLine: 1, text: 'a();\n' }] };

function adapterFor(gateway: boolean) {
  return gateway ? new VercelGatewayAdapter({ model: VERCEL_JEV_MODEL, apiKey: 'synthetic' })
    : new JevAdapter({ model: 'jev-1.13.0', apiKey: 'synthetic', baseUrl: 'https://api.typesafe.ai' });
}

test('ambiguous usage retains valid scores but never releases a reservation as known zero', async (t) => {
  for (const gateway of [false, true]) {
    const answer = gateway ? '{"type":"boolean","probability":0.9}' : '{"type":"noul","noul":0.9}';
    const field = gateway ? 'inputTokens' : 'input_tokens';
    for (const usage of [`"usage":{"${field}":1000000,"${field}":0}`, `"usage":{"${field}":1000000},"usage":{"${field}":0}`]) {
      t.mock.method(globalThis, 'fetch', async () => new Response(`{"answers":{"first":${answer}},${usage}}`));
      const result = await adapterFor(gateway).evaluateBatch(batch);
      assert.equal(result.scores.get('first'), 0.9); assert.equal(result.usage.inputTokens, null);
    }
  }
});

test('one malformed answer cannot discard a valid neighbor and usable billing data', async (t) => {
  const neighbors = { ...batch, items: [...batch.items, { ...batch.items[0]!, id: 'second' }] };
  for (const gateway of [false, true]) {
    const type = gateway ? 'boolean' : 'noul'; const field = gateway ? 'probability' : 'noul';
    t.mock.method(globalThis, 'fetch', async () => Response.json({
      answers: { first: { type, [field]: 0.9 }, second: { type, [field]: 'bad' } },
      usage: gateway ? { inputTokens: 10 } : { input_tokens: 10 }, warnings: 'malformed metadata',
    }));
    const result = await adapterFor(gateway).evaluateBatch(neighbors);
    assert.deepEqual([...result.scores], [['first', 0.9]]); assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.invalid[0]?.id, 'second');
  }
});

test('HTTP failure status and Retry-After survive invalid or oversized response bodies', async (t) => {
  for (const gateway of [false, true]) for (const status of [401, 429]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0xff]), {
      status, headers: { 'retry-after': '5', 'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) },
    }));
    await assert.rejects(adapterFor(gateway).evaluateBatch(batch), (cause: unknown) => {
      assert.ok(cause instanceof ProviderError); assert.equal(cause.status, status);
      assert.equal(cause.code, status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_RATE_LIMIT');
      assert.equal(cause.retryAfterMs, status === 429 ? 5_000 : null); return true;
    });
  }
});

test('response bounds apply to declared and streamed lengths and cancel consumption', async (t) => {
  for (const declared of [true, false]) {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) } : {} }));
    await assert.rejects(boundedFetch('https://synthetic.invalid'), /byte limit/);
    assert.ok(cancelled);
  }
});

test('redirects remain manual and a stalled body can be aborted', async (t) => {
  let mode: RequestInit['redirect']; let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    mode = init.redirect;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const abort = new AbortController();
  const result = boundedFetch('https://synthetic.invalid', { signal: abort.signal });
  await Promise.resolve(); abort.abort();
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(mode, 'manual'); assert.ok(cancelled);
});

test('duplicate detection decodes escaped keys and distinguishes unrelated metadata', () => {
  assert.deepEqual([...duplicateAnswerKeys('{"answers":{"first":1,"\\u0066irst":2}}', ['first'])], ['first']);
  assert.deepEqual([...duplicateAnswerKeys('{"answers":{"first":{"type":"noul","noul":0,"noul":1}}}', ['first'])], ['first']);
  assert.deepEqual([...duplicateAnswerKeys('{"answers":{"first":1},"metadata":{"first":2}}', ['first'])], []);
  assert.deepEqual([...duplicateAnswerKeys('{"answers":{"first":1},"answers":{"first":2}}', ['first'])], ['first']);
});

test('the production Gateway SDK sends exactly the accounted body and emits no warning bodies', async (t) => {
  const wires: string[] = []; let logs = 0;
  t.mock.method(console, 'warn', () => { logs++; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, 'manual'); wires.push(String(init.body));
    return Response.json({ answers: { first: { type: 'boolean', probability: 0.9 } },
      usage: { inputTokens: 123, outputTokens: 0 }, warnings: [{ type: 'other', message: 'synthetic sensitive body' }] });
  });
  const adapter = new VercelGatewayAdapter({ model: VERCEL_JEV_MODEL, apiKey: 'synthetic-secret' });
  const evaluation = await adapter.evaluateBatch(batch);
  assert.equal(wires.length, 1); assert.equal(wires[0], adapter.serializeBatch(batch));
  assert.equal(evaluation.transmittedBytes, Buffer.byteLength(wires[0]!));
  assert.equal(evaluation.scores.get('first'), 0.9); assert.equal(logs, 0);
});

test('escaped duplicate answer keys never become scores through either production transport', async (t) => {
  for (const gateway of [false, true]) {
    const answer = gateway ? '{"type":"boolean","probability":0.9}' : '{"type":"noul","noul":0.9}';
    t.mock.method(globalThis, 'fetch', async () => new Response(`{"answers":{"first":${answer},"\\u0066irst":${answer}}}`));
    const adapter = gateway ? new VercelGatewayAdapter({ model: VERCEL_JEV_MODEL, apiKey: 'synthetic' })
      : new JevAdapter({ model: 'jev-1.13.0', apiKey: 'synthetic', baseUrl: 'https://api.typesafe.ai' });
    const result = await adapter.evaluateBatch(batch); assert.equal(result.scores.size, 0); assert.equal(result.invalid.length, 1);
  }
});

test('engine accounting uses the Gateway wire envelope including SDK providerOptions', async (t) => {
  let bytes = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bytes += Buffer.byteLength(String(init.body));
    const payload = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    return Response.json({ answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: 'boolean', probability: 0.9 }])),
      usage: { inputTokens: 100, outputTokens: 0 } });
  });
  const space = createWorkspace({ files: { 'a.ts': 'const a = 1;\n' } });
  try {
    const provider = new VercelGatewayAdapter({ model: VERCEL_JEV_MODEL, apiKey: 'synthetic' });
    const { outcome } = await createSearchEngine({ configuration: space.loaded, provider }).search({ query: 'q' });
    assert.ok('report' in outcome); assert.equal(outcome.report.usage.transmitted_bytes, bytes);
    assert.ok(bytes > 0); assert.equal(outcome.status, 'complete');
  } finally { space.cleanup(); }
});
