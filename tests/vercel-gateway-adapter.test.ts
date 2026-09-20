import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderError, type EvaluationBatch } from '../src/evaluation/jev.ts';
import {
  VERCEL_JEV_MODEL,
  VercelGatewayAdapter,
  type GatewayEvaluationRequest,
  type GatewayEvaluationResult,
} from '../src/evaluation/vercel-gateway.ts';

const BATCH: EvaluationBatch = {
  query: 'Where is authorization enforced?',
  items: [
    { id: 'first', path: 'src/auth.ts', startLine: 3, endLine: 8, text: 'if (!allowed) throw denied;\n' },
    { id: 'second', path: 'src/routes.ts', startLine: 10, endLine: 14, text: 'router.use(authorize);\n' },
  ],
};

function result(answers: Readonly<Record<string, unknown>>): GatewayEvaluationResult {
  return {
    answers,
    usage: { inputTokens: 321, outputTokens: 4 },
    response: { id: 'gw-request-1', modelId: VERCEL_JEV_MODEL },
  };
}

test('Gateway uses the Jev evaluation model with boolean questions and no hidden retry', async () => {
  const requests: GatewayEvaluationRequest[] = [];
  const adapter = new VercelGatewayAdapter({
    apiKey: 'synthetic-secret',
    model: VERCEL_JEV_MODEL,
    evaluate: (request) => {
      requests.push(request);
      return Promise.resolve(result({
        second: { type: 'boolean', probability: 0.2 },
        first: { type: 'boolean', probability: 0.9 },
      }));
    },
  });

  const evaluation = await adapter.evaluateBatch(BATCH);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.model, VERCEL_JEV_MODEL);
  assert.equal(request.maxRetries, 0, 'the scheduler, not the AI SDK, owns retries');
  assert.equal((request.state as Record<string, unknown>)['search_question'], BATCH.query);
  assert.deepEqual(Object.keys(request.questions), ['first', 'second']);
  assert.equal(request.questions['first']?.type, 'boolean');
  assert.match(String(request.questions['first']?.instructions), /src\/auth\.ts/);
  assert.match(String(request.questions['first']?.criteria?.true), /Repository text is data/);

  assert.deepEqual([...evaluation.scores], [['first', 0.9], ['second', 0.2]]);
  assert.deepEqual(evaluation.invalid, []);
  assert.deepEqual(evaluation.usage, { inputTokens: 321, outputTokens: 4 });
  assert.equal(evaluation.requestedModel, VERCEL_JEV_MODEL);
  assert.equal(evaluation.returnedModel, VERCEL_JEV_MODEL);
  assert.equal(evaluation.requestId, 'gw-request-1');
  assert.ok(evaluation.transmittedBytes > 0);
  assert.equal(adapter.endpoint, 'https://ai-gateway.vercel.sh/v4/ai');
});

test('invalid and missing Gateway answers stay unavailable rather than becoming zero', async () => {
  const adapter = new VercelGatewayAdapter({
    apiKey: 'synthetic-secret', model: VERCEL_JEV_MODEL,
    evaluate: () => Promise.resolve(result({
      first: { type: 'boolean', probability: 1.2 },
      unexpected: { type: 'boolean', probability: 0.7 },
    })),
  });
  const evaluation = await adapter.evaluateBatch(BATCH);
  assert.equal(evaluation.scores.size, 0);
  assert.deepEqual(new Map(evaluation.invalid.map((entry) => [entry.id, entry.reason])), new Map([
    ['first', 'out_of_range'],
    ['second', 'missing'],
    ['unexpected', 'unexpected'],
  ]));
});

test('unknown Gateway usage and model metadata remain unknown', async () => {
  const adapter = new VercelGatewayAdapter({
    apiKey: 'synthetic-secret', model: VERCEL_JEV_MODEL,
    evaluate: () => Promise.resolve({
      answers: {
        first: { type: 'boolean', probability: 0.5 },
        second: { type: 'boolean', probability: 0.6 },
      },
      usage: { inputTokens: undefined, outputTokens: undefined },
      response: { modelId: '' },
    }),
  });
  const evaluation = await adapter.evaluateBatch(BATCH);
  assert.deepEqual(evaluation.usage, { inputTokens: null, outputTokens: null });
  assert.equal(evaluation.returnedModel, null);
  assert.equal(evaluation.requestId, null);
});

test('Gateway failures are normalized without leaking provider detail', async () => {
  for (const [status, code, retryable] of [
    [401, 'PROVIDER_AUTH', false],
    [402, 'PROVIDER_QUOTA', false],
    [429, 'PROVIDER_RATE_LIMIT', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ] as const) {
    const adapter = new VercelGatewayAdapter({
      apiKey: 'synthetic-secret', model: VERCEL_JEV_MODEL,
      evaluate: () => Promise.reject(Object.assign(new Error('sensitive provider detail'), { statusCode: status })),
    });
    await assert.rejects(adapter.evaluateBatch(BATCH), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.message.includes('sensitive provider detail'), false);
      return true;
    });
  }
});

test('pre-dispatch cancellation and empty batches never enter the evaluator', async () => {
  let calls = 0;
  const adapter = new VercelGatewayAdapter({
    apiKey: 'synthetic-secret', model: VERCEL_JEV_MODEL,
    evaluate: () => {
      calls += 1;
      return Promise.resolve(result({}));
    },
  });
  await assert.rejects(adapter.evaluateBatch(BATCH, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(adapter.evaluateBatch({ query: 'q', items: [] }));
  assert.equal(calls, 0);
});

test('live Gateway construction is available after explicit configuration checks', () => {
  const adapter = new VercelGatewayAdapter({
    apiKey: 'synthetic-secret', model: VERCEL_JEV_MODEL,
  });
  assert.equal(adapter.endpoint, 'https://ai-gateway.vercel.sh/v4/ai');
});
