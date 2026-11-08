import { CLOUDFLARE_BASE_PATTERN, CLOUDFLARE_JEV_MODEL, isLiteLLMBaseUrl, JEV_MODEL_PATTERN, PORTKEY_BASE_URL, PORTKEY_MODEL_PATTERN } from '../provider-settings.ts';
import { ProviderError, type BatchEvaluation, type EvaluationBatch, type ProviderClient } from './contracts.ts';
import { fetchTransport, type ProviderTransport } from './http.ts';
import { buildRequestPayload, evaluateDecisionRequest } from './jev.ts';

export type DecisionGatewayKind = 'cloudflare' | 'litellm' | 'portkey';
export type DecisionGatewayOptions = {
  readonly adapter: DecisionGatewayKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly transport?: ProviderTransport;
};

export function serializeDecisionGatewayBatch(adapter: DecisionGatewayKind, model: string, batch: EvaluationBatch): string {
  const payload = buildRequestPayload(batch, model);
  return JSON.stringify(adapter === 'cloudflare'
    ? { model, input: { state: payload.state, questions: payload.questions } } : payload);
}

/** One bounded System One exchange; upstream gateway routing remains operator-owned. */
export class DecisionGatewayAdapter implements ProviderClient {
  readonly model: string;
  readonly endpoint: string;
  readonly #options: DecisionGatewayOptions;

  constructor(options: DecisionGatewayOptions) {
    const valid = options.adapter === 'cloudflare'
      ? CLOUDFLARE_BASE_PATTERN.test(options.baseUrl) && options.model === CLOUDFLARE_JEV_MODEL
      : options.adapter === 'litellm' ? isLiteLLMBaseUrl(options.baseUrl) && JEV_MODEL_PATTERN.test(options.model)
      : /^https:\/\/api\.portkey\.ai\/?$/.test(options.baseUrl) && PORTKEY_MODEL_PATTERN.test(options.model);
    if (!valid) throw new Error('invalid decision gateway endpoint or Jev model');
    this.#options = options;
    this.model = options.model;
    const base = options.baseUrl.replace(/\/$/, '');
    this.endpoint = options.adapter === 'cloudflare' ? `${base}/ai/run`
      : options.adapter === 'litellm' ? `${base}/typesafe/v1/systemone` : `${PORTKEY_BASE_URL}/v1/decisions`;
  }

  serializeBatch(batch: EvaluationBatch): string {
    return serializeDecisionGatewayBatch(this.#options.adapter, this.model, batch);
  }

  async evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal, preparedBody?: string): Promise<BatchEvaluation> {
    signal?.throwIfAborted();
    if (batch.items.length === 0) throw new ProviderError({
      code: 'INVALID_PROVIDER_RESPONSE', message: 'an evaluation batch must contain at least one excerpt',
      retryable: false, ambiguous: false,
    });
    const { adapter, apiKey, transport } = this.#options;
    return evaluateDecisionRequest({
      url: this.endpoint, method: 'POST',
      headers: {
        ...(adapter === 'portkey' ? { 'x-portkey-api-key': apiKey } : { authorization: `Bearer ${apiKey}` }),
        'content-type': 'application/json', accept: 'application/json', 'user-agent': 'jevgrep',
      },
      body: preparedBody ?? this.serializeBatch(batch),
    }, batch, this.model, transport ?? fetchTransport, signal, adapter === 'cloudflare');
  }
}
