/** Provider limits and local safety policies; estimates are not billing tokens. */
import { countReferenceTokens } from '../response/token-counter.ts';

export type AdapterKind = 'typesafe-direct' | 'vercel-ai-gateway';
export const DEFAULT_DIRECT_MODEL = 'jev-1.13.0';
export const MAX_ROLLING_TTL_SECONDS = 900;

export type BatchLimits = {
  readonly totalTokens: number;
  readonly perQuestionTokens: number;
  readonly headroomRatio: number;
  readonly maxItems: number;
  readonly maxRequestBytes: number;
};

export function batchLimits(adapter: AdapterKind = 'typesafe-direct'): BatchLimits {
  return {
    // TypeSafe documents 64k total and 32k per question. Gateway advertises a
    // 32k context; treating that as an aggregate cap is our conservative policy.
    totalTokens: adapter === 'typesafe-direct' ? 64_000 : 32_000,
    perQuestionTokens: 32_000,
    headroomRatio: 0.7, // Provider tokenizer is not public.
    maxItems: 64, // Local request/response bound, not a provider limit.
    maxRequestBytes: 262_144,
  };
}

/** Count the actual wire envelope, including state, criteria and question keys. */
export function fitsSerializedBatch(body: string, limits: BatchLimits): boolean {
  if (Buffer.byteLength(body, 'utf8') > limits.maxRequestBytes) return false;
  const payload = JSON.parse(body) as { state: unknown; questions: Record<string, unknown> };
  const questions = Object.values(payload.questions);
  if (questions.length > limits.maxItems) return false;
  if (countReferenceTokens(body) > limits.totalTokens * limits.headroomRatio) return false;
  const stateTokens = countReferenceTokens(JSON.stringify(payload.state));
  return questions.every((question) => stateTokens + countReferenceTokens(JSON.stringify(question))
    <= limits.perQuestionTokens * limits.headroomRatio);
}

export function isPinnedModelRevision(model: string): boolean {
  return /^jev-\d+\.\d+\.\d+$/.test(model);
}

export function isRollingModel(model: string): boolean {
  return model === 'typesafe-ai/jev' || model === 'jev-latest' || model === 'jev-preview';
}

export function scoreCachePolicy(adapter: AdapterKind, model: string, cache: {
  readonly enabled: boolean; readonly ttl_seconds: number; readonly rolling_ttl_seconds?: number;
}): { mode: 'pinned' | 'rolling' | 'disabled'; ttlSeconds: number } {
  if (!cache.enabled) return { mode: 'disabled', ttlSeconds: 0 };
  if (adapter === 'typesafe-direct' && isPinnedModelRevision(model)) {
    return { mode: 'pinned', ttlSeconds: cache.ttl_seconds };
  }
  const rolling = adapter === 'vercel-ai-gateway' ? model === 'typesafe-ai/jev'
    : model === 'jev-latest' || model === 'jev-preview';
  const ttlSeconds = Math.min(cache.ttl_seconds, cache.rolling_ttl_seconds ?? MAX_ROLLING_TTL_SECONDS,
    MAX_ROLLING_TTL_SECONDS);
  return rolling && ttlSeconds > 0 ? { mode: 'rolling', ttlSeconds } : { mode: 'disabled', ttlSeconds: 0 };
}
