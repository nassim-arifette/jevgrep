/**
 * Evaluation contracts shared by every Jev provider adapter, the scheduler and the
 * engine: batches, validated evaluations, normalized provider errors and the narrow
 * client seam. Wire formats and response handling stay in each adapter.
 */
export type BatchItem = {
  /** Correlation key; the provider returns answers under this id. */
  readonly id: string;
  /** Repository-relative path, model-visible metadata and part of evaluation identity. */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly label?: string | null;
};

/** A versioned model-visible judgment; its text and version are part of the request body. */
export type JudgmentCriterion = { readonly version: string; readonly text: string };

/**
 * Versioned model-visible request layouts (roadmap section 11). `layout-a-1` repeats
 * the criterion in every question; the compact layouts state it once in shared state,
 * either with no per-question criteria or with a short pointer to it.
 */
export type RequestLayout =
  | 'layout-a-1' | 'layout-compact-state-1' | 'layout-compact-ref-1'
  /** Location-independent layouts: no `Lines:` header, or no `File:` and `Lines:` headers. */
  | 'layout-a-nolines-1' | 'layout-a-noloc-1';

/** Layouts that never show the model a line range, so a moved excerpt keeps its cached score. */
export const LINE_FREE_LAYOUTS: ReadonlySet<RequestLayout> = new Set(['layout-a-nolines-1', 'layout-a-noloc-1']);

export type EvaluationBatch = {
  readonly query: string;
  readonly items: readonly BatchItem[];
  /**
   * Experimental judgment replacing the relevance criterion for every item (roadmap
   * section 14, E8). Absent in production searches, whose payload is unchanged.
   */
  readonly criterion?: JudgmentCriterion;
  /**
   * Experimental request layout (bench:layouts only); absent means `layout-a-1`, whose bytes
   * are unchanged. The engine never sets it, so cache identities keep LAYOUT_VERSION.
   */
  readonly layout?: RequestLayout;
};

export type ProviderUsage = {
  /** null means the provider reported no usable usage; it is never turned into zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export type InvalidAnswer = {
  readonly id: string;
  readonly reason: 'missing' | 'unexpected' | 'wrong_type' | 'not_finite' | 'out_of_range' | 'duplicate';
};

export type BatchEvaluation = {
  /** Validated probabilities, keyed by item id. Absent ids were not evaluated. */
  readonly scores: ReadonlyMap<string, number>;
  readonly invalid: readonly InvalidAnswer[];
  readonly usage: ProviderUsage;
  readonly requestedModel: string;
  /** Model the provider says answered, or null when it does not resolve to a revision. */
  readonly returnedModel: string | null;
  readonly transmittedBytes: number;
  readonly requestId: string | null;
};

export type ProviderErrorCode =
  | 'PROVIDER_AUTH' | 'PROVIDER_QUOTA' | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE' | 'INVALID_PROVIDER_RESPONSE';

/**
 * A normalized provider failure. `ambiguous` marks an attempt that may have been
 * evaluated and billed even though no usable answer came back: such an attempt keeps
 * its usage reservation and is not retried automatically.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  readonly transmittedBytes: number;
  /** A dispatched exchange was aborted by the caller's signal, not a provider refusal. */
  readonly cancelled: boolean;

  constructor(options: {
    code: ProviderErrorCode;
    message: string;
    retryable: boolean;
    ambiguous: boolean;
    retryAfterMs?: number | null;
    status?: number | null;
    transmittedBytes?: number;
    cancelled?: boolean;
  }) {
    super(options.message);
    this.code = options.code;
    this.retryable = options.retryable;
    this.ambiguous = options.ambiguous;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
    this.transmittedBytes = options.transmittedBytes ?? 0;
    this.cancelled = options.cancelled ?? false;
  }
}

/** Narrow provider seam used by the scheduler and by the engine. */
export type ProviderClient = {
  readonly model: string;
  /** Exact outbound JSON body, including the adapter's protocol envelope. */
  serializeBatch?(batch: EvaluationBatch): string;
  /** Prepared body is the exact result of serializeBatch for this immutable batch. */
  evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal, preparedBody?: string): Promise<BatchEvaluation>;
};
