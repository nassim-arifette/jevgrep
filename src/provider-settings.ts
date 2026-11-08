export const ADAPTER_KINDS = ['typesafe-direct', 'vercel-ai-gateway', 'openrouter', 'cloudflare', 'litellm', 'portkey'] as const;
export type AdapterKind = typeof ADAPTER_KINDS[number];
export const INIT_PROVIDERS = ['typesafe', 'vercel', 'openrouter', 'cloudflare', 'litellm', 'portkey'] as const;
export type InitProvider = typeof INIT_PROVIDERS[number];

export function isInitProvider(value: unknown): value is InitProvider {
  return INIT_PROVIDERS.some((provider) => provider === value);
}

export const CLOUDFLARE_JEV_MODEL = 'typesafe/jev';
export const PORTKEY_BASE_URL = 'https://api.portkey.ai';
export const LITELLM_BASE_URL = 'http://localhost:4000';
export const CLOUDFLARE_BASE_PATTERN = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/?$/;
export const PORTKEY_MODEL_PATTERN = /^@[A-Za-z0-9][A-Za-z0-9_-]*\/jev-(?:\d+\.\d+\.\d+|latest|preview)$/;
export const JEV_MODEL_PATTERN = /^jev-(?:\d+\.\d+\.\d+|latest|preview)$/;

/** The operator explicitly trusts this proxy; plaintext credentials stay on loopback. */
export function isLiteLLMBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      && value === url.href.replace(/\/$/, '') + (value.endsWith('/') ? '/' : '')
      && !/%|\/\/|\\/.test(url.pathname);
  } catch { return false; }
}
