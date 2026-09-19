import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configurationSchema } from '../src/contracts.ts';
import type { ProviderClient } from '../src/evaluation/jev.ts';
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
