/**
 * Jev through OpenRouter's alpha Decisions API (not chat completions).
 * Contract: https://openrouter.ai/openapi.json, /api/alpha/decisions.
 * One bounded HTTP exchange per scheduler attempt; no fallback providers.
 */
import {
  buildRequestPayload,
  evaluateDecisionRequest,
  fetchTransport,
  ProviderError,
  type BatchEvaluation,
  type EvaluationBatch,
  type ProviderClient,
  type ProviderTransport,
} from './jev.ts';

export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13' as const;
export const OPENROUTER_BASE_URL = 'https://openrouter.ai' as const;

export type OpenRouterAdapterOptions = {
  readonly apiKey: string;
  readonly model: typeof OPENROUTER_JEV_MODEL;
  readonly baseUrl?: string;
  readonly transport?: ProviderTransport;
};

/** Exact wire payload, also used by offline inspection and search planning. */
export function serializeOpenRouterBatch(batch: EvaluationBatch): string {
  const payload = buildRequestPayload(batch, OPENROUTER_JEV_MODEL);
  return JSON.stringify({
    ...payload,
    questions: Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => [id, {
      ...question,
      // DecisionsNoulQuestion requires both keys when criteria are supplied.
      criteria: {
        ...question.criteria,
        false: 'This excerpt contains no concrete evidence useful for investigating the search question.',
      },
    }])),
    provider: { allow_fallbacks: false },
  });
}

export class OpenRouterAdapter implements ProviderClient {
  readonly model: typeof OPENROUTER_JEV_MODEL;
  readonly #apiKey: string;
  readonly #transport: ProviderTransport;
  readonly #endpoint: string;

  constructor(options: OpenRouterAdapterOptions) {
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#transport = options.transport ?? fetchTransport;
    this.#endpoint = `${(options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '')}/api/alpha/decisions`;
  }

  get endpoint(): string { return this.#endpoint; }

  serializeBatch(batch: EvaluationBatch): string { return serializeOpenRouterBatch(batch); }

  async evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal): Promise<BatchEvaluation> {
    if (signal?.aborted === true) throw new DOMException('evaluation cancelled before dispatch', 'AbortError');
    if (batch.items.length === 0) {
      throw new ProviderError({
        code: 'INVALID_PROVIDER_RESPONSE', message: 'an evaluation batch must contain at least one excerpt',
        retryable: false, ambiguous: false,
      });
    }
    return evaluateDecisionRequest({
      url: this.#endpoint,
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'jevgrep',
      },
      body: this.serializeBatch(batch),
    }, batch, this.model, this.#transport, signal);
  }
}
