import { loadConfiguration, resolveCredential, type LoadedConfiguration } from '../../src/config.ts';
import type { Configuration } from '../../src/contracts.ts';
import { createConfiguredProvider, serializeConfiguredBatch } from '../../src/evaluation/provider.ts';
import { environmentWithProfileSecrets } from '../../src/init.ts';
import { limitProvider } from './limited-provider.ts';

export type LiveCaps = { readonly requests: number; readonly estimatedInputTokens: number };

/** A capped provider built from a trusted configuration; the credential stays in memory. */
export function liveProvider(configPath: string, caps: LiveCaps) {
  const template = loadConfiguration(configPath);
  const credential = resolveCredential(template, environmentWithProfileSecrets(
    template.configPath, process.env, template.sourceRoot, template.config.provider.api_key_env,
  ));
  const serialize = (batch: Parameters<typeof serializeConfiguredBatch>[1]) => serializeConfiguredBatch(template.config, batch);
  const { provider, usage } = limitProvider(createConfiguredProvider(template.config, credential), serialize, caps);
  const exhausted = (): boolean => usage.blocked || usage.attempts >= caps.requests || usage.reservedInputTokens >= caps.estimatedInputTokens;
  /** Copy the trusted provider/search settings into a benchmark workspace, with the remaining budget as scan caps. */
  const configure = (base: Configuration, options: { readonly cache?: boolean } = {}): Configuration => ({
    ...base,
    remote_evaluation_enabled: template.config.remote_evaluation_enabled,
    provider: template.config.provider,
    search: template.config.search,
    scan_caps: {
      ...template.config.scan_caps,
      request_attempts: Math.min(template.config.scan_caps.request_attempts ?? Infinity, caps.requests - usage.attempts),
      estimated_input_tokens: Math.min(template.config.scan_caps.estimated_input_tokens ?? Infinity, caps.estimatedInputTokens - usage.reservedInputTokens),
    },
    cache: { ...base.cache, enabled: options.cache ?? false },
  });
  const settings = {
    adapter: template.config.provider.adapter ?? 'typesafe-direct', model: provider.model,
    baseUrl: template.config.provider.base_url, pricing: template.config.provider.pricing ?? null,
  };
  return { template: template as LoadedConfiguration, provider, usage, caps, exhausted, configure, settings };
}
