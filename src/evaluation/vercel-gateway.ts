/**
 * Jev through Vercel AI Gateway.
 *
 * AI Gateway exposes Jev as an evaluation model, not as an OpenAI-compatible chat
 * model. This adapter therefore uses the AI SDK evaluation API and pins retries to
 * zero so one scheduler attempt remains one provider attempt.
 *
 * Tests inject the evaluator and never contact Vercel; the default implementation uses
 * the configured Vercel AI Gateway account.
 */
import { createGateway, type GatewayEvaluationModelId } from '@ai-sdk/gateway';
import {
  type Experimental_EvaluationModel,
  type Experimental_EvaluationQuestion,
  type JSONValue,
} from 'ai';

import {
  CRITERION_VERSION,
  LAYOUT_VERSION,
  ProviderError,
  RELEVANCE_CRITERION,
  questionInstructions,
  parseRetryAfter,
  inspectResponseKeys,
  type BatchEvaluation,
  type EvaluationBatch,
  type InvalidAnswer,
  type ProviderClient,
} from './jev.ts';
import { boundedFetch } from './http.ts';

/** Validate each association before the SDK's all-or-nothing envelope validator. */
const gatewayFetch: typeof fetch = async (input, init) => {
  const response = await boundedFetch(input, init);
  if (!response.ok || typeof init?.body !== 'string') return response;
  const raw = await response.text();
  try {
    const request = JSON.parse(init.body) as { questions: Record<string, unknown> };
    const body = JSON.parse(raw) as { answers?: unknown; usage?: unknown };
    const answers = errorRecord(body.answers);
    if (answers === null || Array.isArray(answers)) throw new Error('invalid answer map');
    const keys = inspectResponseKeys(raw, Object.keys(request.questions));
    const associations = Object.fromEntries(Object.entries(answers).filter(([id]) => !keys.answers.has(id)).map(([id, value]) => {
      const answer = errorRecord(value);
      // A schema-valid wrong-type sentinel reaches our per-item normalizer without
      // turning one malformed neighbor into a rejected batch or a fabricated score.
      return [id, answer?.['type'] === 'boolean' && typeof answer['probability'] === 'number' && Number.isFinite(answer['probability'])
        ? { type: 'boolean', probability: answer['probability'] } : { type: 'choice', choice: '' }];
    }));
    const usage = keys.usageAmbiguous ? null : errorRecord(body.usage);
    const inputTokens = usableCount(usage?.['inputTokens']); const outputTokens = usableCount(usage?.['outputTokens']);
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(JSON.stringify({ answers: associations, usage: {
      ...(inputTokens === null ? {} : { inputTokens }), ...(outputTokens === null ? {} : { outputTokens }),
    } }), { status: response.status, headers });
  } catch {
    // The SDK's schema validator owns malformed JSON/envelopes.
    return new Response(raw, { status: response.status, headers: response.headers });
  }
};

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

/** Injectable seam: production uses the SDK model operation; tests can use a local fake. */
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

export function serializeGatewayBatch(batch: EvaluationBatch): string {
  return JSON.stringify({ ...buildGatewayInput(batch), providerOptions: {} });
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
  let retryAfterMs: number | null = null;
  let current = errorRecord(cause);
  for (let depth = 0; depth < 4 && current !== null; depth++) {
    const headers = current['responseHeaders'];
    const value = headers instanceof Headers ? headers.get('retry-after') : errorRecord(headers)?.['retry-after'];
    if (typeof value === 'string') retryAfterMs = parseRetryAfter(value);
    current = errorRecord(current['cause']);
  }
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
      retryable: true, ambiguous: false, status, transmittedBytes, retryAfterMs,
    });
  }
  if (status !== null && status >= 500) {
    return new ProviderError({
      code: 'PROVIDER_UNAVAILABLE', message: `AI Gateway is unavailable (HTTP ${String(status)})`,
      retryable: true, ambiguous: true, status, transmittedBytes, retryAfterMs,
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
    // The SDK echoes the requested alias: it is not a resolved immutable revision.
    returnedModel: result.response.modelId.length > 0 && result.response.modelId !== VERCEL_JEV_MODEL
      ? result.response.modelId : null,
    transmittedBytes,
    requestId: typeof result.response.id === 'string' && result.response.id.length > 0
      ? result.response.id : null,
  };
}

async function evaluateWithAiSdk(request: GatewayEvaluationRequest): Promise<GatewayEvaluationResult> {
  if (typeof request.model === 'string') throw new Error('a Gateway evaluation model is required');
  // The model operation has no retry layer or warning logger. Keep provider bodies
  // and warning strings out of stdout/stderr; per-item validation belongs below.
  const result = await request.model.doEvaluate({
    state: request.state,
    questions: request.questions,
    providerOptions: {},
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  });
  return {
    answers: result.answers,
    usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
    response: { modelId: result.response?.modelId ?? '', ...(result.response?.id === undefined ? {} : { id: result.response.id }) },
  };
}

export class VercelGatewayAdapter implements ProviderClient {
  readonly model: typeof VERCEL_JEV_MODEL;
  readonly #evaluationModel: Experimental_EvaluationModel;
  readonly #evaluate: GatewayEvaluator;
  readonly #endpoint: string;

  constructor(options: VercelGatewayAdapterOptions) {
    this.model = options.model;
    const baseUrl = (options.baseUrl ?? VERCEL_GATEWAY_BASE_URL).replace(/\/$/, '');
    this.#endpoint = `${baseUrl}/v4/ai`;
    this.#evaluate = options.evaluate ?? evaluateWithAiSdk;
    this.#evaluationModel = options.evaluationModel ?? (options.evaluate === undefined
      ? createGateway({ apiKey: options.apiKey, baseURL: this.#endpoint, fetch: gatewayFetch }).evaluation(options.model)
      : options.model);
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  serializeBatch(batch: EvaluationBatch): string {
    return serializeGatewayBatch(batch);
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
    // This is the serialized evaluation input Jev receives. Gateway may add its own
    // protocol envelope, so this remains a conservative application-level measurement.
    const transmittedBytes = Buffer.byteLength(this.serializeBatch(batch), 'utf8');
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
