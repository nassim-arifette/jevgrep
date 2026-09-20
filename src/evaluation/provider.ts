/** Select the configured Jev transport after configuration and credential validation. */
import { ConfigurationError } from '../config.ts';
import type { Configuration } from '../contracts.ts';
import { JevAdapter, type JevAdapterOptions, type ProviderClient } from './jev.ts';
import {
  VERCEL_JEV_MODEL,
  VercelGatewayAdapter,
  type VercelGatewayAdapterOptions,
} from './vercel-gateway.ts';

export type ProviderAdapterKind = 'typesafe-direct' | 'vercel-ai-gateway';

export type ProviderFactories = {
  readonly direct: (options: JevAdapterOptions) => ProviderClient;
  readonly gateway: (options: VercelGatewayAdapterOptions) => ProviderClient;
};

const defaultFactories: ProviderFactories = {
  direct: (options) => new JevAdapter(options),
  gateway: (options) => new VercelGatewayAdapter(options),
};

/** Missing selectors are the legacy direct adapter, preserving existing v1 files. */
export function configuredAdapter(config: Configuration): ProviderAdapterKind {
  return config.provider.adapter ?? 'typesafe-direct';
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
