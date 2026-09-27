import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configurationSchema } from '../src/contracts.ts';
import { JevAdapter, ProviderError, type ProviderClient, type TransportRequest, type TransportResponse } from '../src/evaluation/jev.ts';
import { configuredAdapter, createConfiguredProvider, type ProviderFactories } from '../src/evaluation/provider.ts';
import type { JevAdapterOptions } from '../src/evaluation/jev.ts';
import type { VercelGatewayAdapterOptions } from '../src/evaluation/vercel-gateway.ts';
import { validConfiguration } from './fixtures/contracts.ts';

const provider: ProviderClient = {
  model: 'fake',
  evaluateBatch: () => Promise.reject(new Error('not used')),
};

test('the provider factory preserves legacy direct configuration', () => {
  let direct: JevAdapterOptions | undefined;
  let gatewayCalls = 0;
  const factories: ProviderFactories = {
    direct: (options) => { direct = options; return provider; },
    gateway: () => { gatewayCalls += 1; return provider; },
  };
  const legacy = structuredClone(validConfiguration) as Record<string, unknown>;
  const legacyProvider = structuredClone(validConfiguration.provider) as Record<string, unknown>;
  delete legacyProvider['adapter'];
  legacy['provider'] = legacyProvider;
  const parsed = configurationSchema.parse(legacy);

  assert.equal(configuredAdapter(parsed), 'typesafe-direct');
  assert.equal(createConfiguredProvider(parsed, 'direct-secret', factories), provider);
  assert.equal(direct?.baseUrl, 'https://api.typesafe.ai');
  assert.equal(direct?.apiKey, 'direct-secret');
  assert.equal(gatewayCalls, 0);
});

test('the provider factory selects AI Gateway with the official Jev model id', () => {
  let gateway: VercelGatewayAdapterOptions | undefined;
  let directCalls = 0;
  const factories: ProviderFactories = {
    direct: () => { directCalls += 1; return provider; },
    gateway: (options) => { gateway = options; return provider; },
  };
  const config = configurationSchema.parse({
    ...validConfiguration,
    provider: {
      adapter: 'vercel-ai-gateway',
      base_url: 'https://ai-gateway.vercel.sh',
      api_key_env: 'AI_GATEWAY_API_KEY',
      model: 'typesafe-ai/jev',
    },
  });

  assert.equal(configuredAdapter(config), 'vercel-ai-gateway');
  assert.equal(createConfiguredProvider(config, 'gateway-secret', factories), provider);
  assert.equal(gateway?.baseUrl, 'https://ai-gateway.vercel.sh');
  assert.equal(gateway?.model, 'typesafe-ai/jev');
  assert.equal(gateway?.apiKey, 'gateway-secret');
  assert.equal(directCalls, 0);
});

const COMPATIBLE = {
  adapter: 'systemone-compatible',
  base_url: 'https://litellm.example.com/typesafe/',
  api_key_env: 'LITELLM_API_KEY',
  model: 'jev-1.13.0',
} as const;

function compatibleProvider(responses: TransportResponse[], requests: TransportRequest[]): ProviderClient {
  const config = configurationSchema.parse({ ...validConfiguration, provider: COMPATIBLE });
  assert.equal(configuredAdapter(config), 'systemone-compatible');
  return createConfiguredProvider(config, 'virtual-key', {
    direct: (options) => new JevAdapter({ ...options, transport: (request) => {
      requests.push(request);
      return Promise.resolve(responses.shift() ?? { status: 500, headers: {}, text: '' });
    } }),
    gateway: () => assert.fail('a System One compatible endpoint never uses the AI Gateway client'),
  });
}

const BATCH = { query: 'Where is the session refreshed?', items: [
  { id: 'f-one', path: 'src/session.ts', startLine: 1, endLine: 3, text: 'export function refresh() {}\n', label: null },
] };

test('a System One compatible endpoint reuses the direct client at its own base URL', async () => {
  const requests: TransportRequest[] = [];
  const client = compatibleProvider([{ status: 200, headers: {}, text: JSON.stringify({
    model: 'jev-1.13.0', answers: { 'f-one': { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12 },
  }) }], requests);
  assert.ok(client instanceof JevAdapter);
  assert.equal(client.endpoint, 'https://litellm.example.com/typesafe/v1/systemone');

  const evaluation = await client.evaluateBatch(BATCH);
  assert.equal(evaluation.scores.get('f-one'), 0.8);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.url, 'https://litellm.example.com/typesafe/v1/systemone');
  assert.equal(requests[0]?.headers['authorization'], 'Bearer virtual-key');
  assert.equal(JSON.parse(requests[0]?.body ?? '{}').model, 'jev-1.13.0');
  assert.ok(!requests[0]?.body.includes('virtual-key'));
});

test('gateway authentication and rate-limit statuses keep their provider error families', async () => {
  for (const [status, code, retryable] of [[401, 'PROVIDER_AUTH', false], [403, 'PROVIDER_AUTH', false], [429, 'PROVIDER_RATE_LIMIT', true]] as const) {
    const client = compatibleProvider([{ status, headers: {}, text: '{"error":"budget or key detail"}' }], []);
    await assert.rejects(client.evaluateBatch(BATCH), (error: unknown) =>
      error instanceof ProviderError && error.code === code && error.retryable === retryable && !error.message.includes('budget'));
  }
});
