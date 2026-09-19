/**
 * Jev through Vercel AI Gateway.
 *
 * AI Gateway exposes Jev as an evaluation model, not as an OpenAI-compatible chat
 * model. This adapter therefore uses the AI SDK evaluation API and pins retries to
 * zero so one scheduler attempt remains one provider attempt.
 *
 * Live construction remains behind the repository qualification gate. Tests inject
 * the evaluator and never contact Vercel.
 */
import { createGateway, type GatewayEvaluationModelId } from '@ai-sdk/gateway';
import {
  experimental_evaluate,
  type Experimental_EvaluationModel,
  type Experimental_EvaluationQuestion,
  type JSONValue,
} from 'ai';

import { requireQualifiedLiveSearch } from '../readiness.ts';
import {
  CRITERION_VERSION,
  LAYOUT_VERSION,
  ProviderError,
  RELEVANCE_CRITERION,
  questionInstructions,
  type BatchEvaluation,
  type EvaluationBatch,
  type InvalidAnswer,
  type ProviderClient,
} from './jev.ts';

export const VERCEL_JEV_MODEL = 'typesafe-ai/jev' as const satisfies GatewayEvaluationModelId;
export const VERCEL_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh' as const;

type GatewayBooleanQuestion = Extract<Experimental_EvaluationQuestion, { type: 'boolean' }>;

export type GatewayEvaluationRequest = {
  readonly model: Experimental_EvaluationModel;
  readonly state: string | Readonly<Record<string, JSONValue>> | readonly JSONValue[];
  readonly questions: Readonly<Record<string, GatewayBooleanQuestion>>;
  readonly maxRetries: 0;
  readonly abortSignal?: AbortSignal;
};

export type GatewayEvaluationResult = {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  };
  readonly response: {
    readonly id?: string;
    readonly modelId: string;
  };
};

/** Injectable seam: production uses `experimental_evaluate`; tests use a local fake. */
export type GatewayEvaluator = (request: GatewayEvaluationRequest) => Promise<GatewayEvaluationResult>;

export type VercelGatewayAdapterOptions = {
  readonly apiKey: string;
  readonly model: typeof VERCEL_JEV_MODEL;
  /** Root Gateway URL. The AI SDK evaluation API lives below `/v4/ai`. */
  readonly baseUrl?: string;
  readonly evaluate?: GatewayEvaluator;
  readonly evaluationModel?: Experimental_EvaluationModel;
};

function buildGatewayInput(batch: EvaluationBatch): {
  state: Readonly<Record<string, string>>;
  questions: Readonly<Record<string, GatewayBooleanQuestion>>;
} {
  const questions: Record<string, GatewayBooleanQuestion> = {};
  for (const item of batch.items) {
    questions[item.id] = {
      type: 'boolean',
      instructions: questionInstructions(item),
      criteria: { true: RELEVANCE_CRITERION },
    };
  }
  return {
    state: {
      search_question: batch.query,
      criterion: RELEVANCE_CRITERION,
      criterion_version: CRITERION_VERSION,
      layout: LAYOUT_VERSION,
    },
    questions,
  };
}

function usableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : null;
}

function statusFromError(cause: unknown): number | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = errorRecord(current);
    if (record === null) {
      return null;
    }
    const status = record['statusCode'] ?? record['status'];
    if (typeof status === 'number' && Number.isInteger(status)) {
      return status;
    }
    const response = errorRecord(record['response']);
    const responseStatus = response?.['status'];
    if (typeof responseStatus === 'number' && Number.isInteger(responseStatus)) {
      return responseStatus;
    }
    current = record['cause'];
  }
  return null;
}

function classifyGatewayError(cause: unknown, transmittedBytes: number, signal?: AbortSignal): ProviderError {
  const status = statusFromError(cause);
  const cancelled = Boolean(signal?.aborted)
    && cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'DOMException');
  if (status === 401 || status === 403) {
    return new ProviderError({
      code: 'PROVIDER_AUTH', message: `AI Gateway rejected the credential or model access (HTTP ${String(status)})`,
      retryable: false, ambiguous: false, status, transmittedBytes,
    });
  }
  if (status === 402 || status === 409) {
    return new ProviderError({
      code: 'PROVIDER_QUOTA', message: `AI Gateway account quota is exhausted (HTTP ${String(status)})`,
      retryable: false, ambiguous: false, status, transmittedBytes,
    });
  }
  if (status === 429) {
    return new ProviderError({
      code: 'PROVIDER_RATE_LIMIT', message: 'AI Gateway rate limit reached',
      retryable: true, ambiguous: false, status, transmittedBytes,
    });
  }
  if (status !== null && status >= 500) {
    return new ProviderError({
      code: 'PROVIDER_UNAVAILABLE', message: `AI Gateway is unavailable (HTTP ${String(status)})`,
      retryable: true, ambiguous: true, status, transmittedBytes,
    });
  }
  return new ProviderError({
    code: 'PROVIDER_UNAVAILABLE',
    message: cancelled ? 'AI Gateway evaluation was cancelled after dispatch'
      : 'AI Gateway evaluation failed after the request may have been dispatched',
    retryable: false, ambiguous: true, status, transmittedBytes, cancelled,
  });
}

function normalizeGatewayResult(
  result: GatewayEvaluationResult,
  batch: EvaluationBatch,
  requestedModel: string,
  transmittedBytes: number,
): BatchEvaluation {
  const scores = new Map<string, number>();
  const invalid: InvalidAnswer[] = [];
  const requested = new Set(batch.items.map((item) => item.id));

  for (const item of batch.items) {
    if (!Object.hasOwn(result.answers, item.id)) {
      invalid.push({ id: item.id, reason: 'missing' });
      continue;
    }
    const answer = errorRecord(result.answers[item.id]);
    if (answer?.['type'] !== 'boolean') {
      invalid.push({ id: item.id, reason: 'wrong_type' });
      continue;
    }
    const probability = answer['probability'];
    if (typeof probability !== 'number') {
      invalid.push({ id: item.id, reason: 'wrong_type' });
    } else if (!Number.isFinite(probability)) {
      invalid.push({ id: item.id, reason: 'not_finite' });
    } else if (probability < 0 || probability > 1) {
      invalid.push({ id: item.id, reason: 'out_of_range' });
    } else {
      scores.set(item.id, probability);
    }
  }
  for (const id of Object.keys(result.answers)) {
    if (!requested.has(id)) {
      invalid.push({ id, reason: 'unexpected' });
    }
  }

  return {
    scores,
    invalid,
    usage: {
      inputTokens: usableCount(result.usage.inputTokens),
      outputTokens: usableCount(result.usage.outputTokens),
    },
    requestedModel,
    returnedModel: result.response.modelId.length > 0 ? result.response.modelId : null,
    transmittedBytes,
    requestId: typeof result.response.id === 'string' && result.response.id.length > 0
      ? result.response.id : null,
  };
}

async function evaluateWithAiSdk(request: GatewayEvaluationRequest): Promise<GatewayEvaluationResult> {
  const options = {
    model: request.model,
    state: request.state,
    questions: request.questions,
    maxRetries: request.maxRetries,
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  };
  return experimental_evaluate(options);
}

export class VercelGatewayAdapter implements ProviderClient {
  readonly model: typeof VERCEL_JEV_MODEL;
  readonly #evaluationModel: Experimental_EvaluationModel;
  readonly #evaluate: GatewayEvaluator;
  readonly #endpoint: string;

  constructor(options: VercelGatewayAdapterOptions) {
    if (options.evaluate === undefined) {
      requireQualifiedLiveSearch();
    }
    this.model = options.model;
    const baseUrl = (options.baseUrl ?? VERCEL_GATEWAY_BASE_URL).replace(/\/$/, '');
    this.#endpoint = `${baseUrl}/v4/ai`;
    this.#evaluate = options.evaluate ?? evaluateWithAiSdk;
    this.#evaluationModel = options.evaluationModel ?? (options.evaluate === undefined
      ? createGateway({ apiKey: options.apiKey, baseURL: this.#endpoint }).evaluation(options.model)
      : options.model);
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  async evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal): Promise<BatchEvaluation> {
    if (signal?.aborted === true) {
      throw new DOMException('evaluation cancelled before dispatch', 'AbortError');
    }
    if (batch.items.length === 0) {
      throw new ProviderError({
        code: 'INVALID_PROVIDER_RESPONSE', message: 'an evaluation batch must contain at least one excerpt',
        retryable: false, ambiguous: false,
      });
    }

    const input = buildGatewayInput(batch);
    // This is the serialized evaluation input Jev receives. The live gate remains
    // closed until Gateway wire accounting is qualified against a synthetic request.
    const transmittedBytes = Buffer.byteLength(JSON.stringify({
      model: this.model, state: input.state, questions: input.questions,
    }), 'utf8');
    const request: GatewayEvaluationRequest = {
      model: this.#evaluationModel,
      state: input.state,
      questions: input.questions,
      maxRetries: 0,
      ...(signal === undefined ? {} : { abortSignal: signal }),
    };

    let result: GatewayEvaluationResult;
    try {
      result = await this.#evaluate(request);
    } catch (cause) {
      throw classifyGatewayError(cause, transmittedBytes, signal);
    }
    return normalizeGatewayResult(result, batch, this.model, transmittedBytes);
  }
}
