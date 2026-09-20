/** Select the configured Jev transport after configuration and credential validation. */
import { OPENROUTER_JEV_MODEL, OpenRouterAdapter, serializeOpenRouterBatch, type OpenRouterAdapterOptions } from './openrouter.ts';
import { ConfigurationError } from '../config.ts';
import type { Configuration } from '../contracts.ts';
import { JevAdapter, buildRequestPayload, type EvaluationBatch, type JevAdapterOptions, type ProviderClient } from './jev.ts';
import {
  VERCEL_JEV_MODEL,
  VercelGatewayAdapter,
  serializeGatewayBatch,
  type VercelGatewayAdapterOptions,
} from './vercel-gateway.ts';

export type ProviderAdapterKind = 'typesafe-direct' | 'vercel-ai-gateway' | 'openrouter';

export type ProviderFactories = {
  /** Optional to preserve existing callers that inject only the original adapters. */
  readonly openrouter?: (options: OpenRouterAdapterOptions) => ProviderClient;
  readonly direct: (options: JevAdapterOptions) => ProviderClient;
  readonly gateway: (options: VercelGatewayAdapterOptions) => ProviderClient;
};

const defaultFactories = {
  openrouter: (options: OpenRouterAdapterOptions) => new OpenRouterAdapter(options),
  direct: (options: JevAdapterOptions) => new JevAdapter(options),
  gateway: (options: VercelGatewayAdapterOptions) => new VercelGatewayAdapter(options),
};

/** Missing selectors are the legacy direct adapter, preserving existing v1 files. */
export function configuredAdapter(config: Configuration): ProviderAdapterKind {
  return config.provider.adapter ?? 'typesafe-direct';
}

/** Offline planning uses exactly the same envelope as the selected transport. */
export function serializeConfiguredBatch(config: Configuration, batch: EvaluationBatch): string {
  if (configuredAdapter(config) === 'openrouter') return serializeOpenRouterBatch(batch);
  return configuredAdapter(config) === 'vercel-ai-gateway' ? serializeGatewayBatch(batch)
    : JSON.stringify(buildRequestPayload(batch, config.provider.model));
}

export function createConfiguredProvider(
  config: Configuration,
  apiKey: string,
  factories: ProviderFactories = defaultFactories,
): ProviderClient {
  if (configuredAdapter(config) === 'typesafe-direct') {
    return factories.direct({
      baseUrl: config.provider.base_url,
      model: config.provider.model,
      apiKey,
    });
  }
  if (configuredAdapter(config) === 'openrouter') {
    if (config.provider.model !== OPENROUTER_JEV_MODEL) {
      throw new ConfigurationError('INVALID_CONFIG', `openrouter requires provider.model=${OPENROUTER_JEV_MODEL}`);
    }
    return (factories.openrouter ?? defaultFactories.openrouter)({
      baseUrl: config.provider.base_url, model: OPENROUTER_JEV_MODEL, apiKey,
    });
  }
  if (config.provider.model !== VERCEL_JEV_MODEL) {
    // Normally impossible after schema validation; keep the factory safe for typed
    // callers that mutate a parsed object before passing it here.
    throw new ConfigurationError('INVALID_CONFIG',
      `vercel-ai-gateway requires provider.model=${VERCEL_JEV_MODEL}`);
  }
  return factories.gateway({
    baseUrl: config.provider.base_url,
    model: VERCEL_JEV_MODEL,
    apiKey,
  });
}
