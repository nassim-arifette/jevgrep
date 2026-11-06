/**
 * Scan planning shared by search and `inspect`: deterministic batches under the
 * provider's limits, local first-attempt estimates and the enabled-cap preflight.
 *
 * Nothing here contacts a provider or reads source; it works on prepared fragments,
 * so `inspect` can show a search's verdict without importing the search engine.
 */
import type { ScanCap } from './contracts.ts';
import { ConfigurationError } from './config.ts';
import { buildRequestPayload } from './evaluation/jev.ts';
import type { BatchItem, EvaluationBatch } from './evaluation/contracts.ts';
import { batchLimits, measureSerializedBatch, type BatchLimits, type SerializedBatchMeasure } from './evaluation/policy.ts';
import { PREPARE_POOL_MIN_BYTES, acquirePool, countTokensWith, countTokensWithAsync } from './source/prepare-pool.ts';
import { estimateInputCostUsd } from './pricing.ts';
import type { ReportInputs } from './response/render.ts';
import { countReferenceTokens } from './response/token-counter.ts';
import type { PreparedFragment } from './source/chunker.ts';

/** Estimated provider input tokens for a batch; a local estimate, never a bill. */
export type BatchCost = { readonly tokens: number; readonly bytes: number; readonly body?: string };

export function batchCost(batch: EvaluationBatch, model: string, serialize?: (batch: EvaluationBatch) => string): BatchCost {
  const body = serialize?.(batch) ?? JSON.stringify(buildRequestPayload(batch, model));
  return { tokens: countReferenceTokens(body), bytes: Buffer.byteLength(body, 'utf8'), body };
}

/** The same state/question JSON recurs across candidate batches; bound retention. */
export function questionTokenMemo(maxUtf16Bytes = 8 * 1024 * 1024): (value: string) => number {
  const counts = new Map<string, number>();
  let retained = 0;
  return (value) => {
    const hit = counts.get(value);
    if (hit !== undefined) return hit;
    const tokens = countReferenceTokens(value);
    const bytes = value.length * 2;
    if (retained + bytes <= maxUtf16Bytes) {
      counts.set(value, tokens);
      retained += bytes;
    }
    return tokens;
  };
}

export function enabledCapsOf(caps: Readonly<Record<ScanCap, number | null>>): Partial<Record<ScanCap, number>> {
  const enabled: Partial<Record<ScanCap, number>> = {};
  for (const [key, value] of Object.entries(caps)) {
    if (value !== null) {
      enabled[key as ScanCap] = value;
    }
  }
  return enabled;
}

export type ScanPlan = {
  readonly batches: readonly EvaluationBatch[];
  readonly rejected: boolean;
  readonly capReached: boolean;
  readonly report: ReportInputs['preflight'];
};

type PlanOptions = {
  readonly model: string;
  readonly serialize?: (batch: EvaluationBatch) => string;
  readonly batchCost?: (batch: EvaluationBatch) => BatchCost;
  readonly batches?: readonly EvaluationBatch[];
  readonly enabledCaps: Partial<Record<ScanCap, number>>;
  readonly allowPartial: boolean;
  readonly requireFit: boolean;
  readonly preparedBytes: number;
  readonly candidateFiles: number;
  readonly preparedFragments: number;
  readonly pricePerMillionInputTokens: number | null;
};

/**
 * Plan the first attempts and account for the enabled caps (JG-016 seam).
 *
 * Every optional cap is disabled by default and stays disabled when it is `null`; no
 * built-in threshold substitutes for one. A plan that does not fit an enabled cap is
 * rejected before dispatch unless the caller explicitly allowed a partial scan, in
 * which case a deterministic prefix is evaluated.
 */
export function planScan(
  fragments: readonly PreparedFragment[],
  query: string,
  options: PlanOptions,
): ScanPlan {
  const batches = options.batches ?? buildBatches(fragments, query, {
    model: options.model, ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
  });
  const measured = new WeakMap<EvaluationBatch, BatchCost>();
  const costOf = (batch: EvaluationBatch): BatchCost => {
    let cost = measured.get(batch);
    if (cost === undefined) {
      cost = options.batchCost?.(batch) ?? batchCost(batch, options.model, options.serialize);
      measured.set(batch, cost);
    }
    return cost;
  };
  const estimatedTokens = batches.reduce((sum, batch) => sum + costOf(batch).tokens, 0);
  const estimatedBytes = batches.reduce((sum, batch) => sum + costOf(batch).bytes, 0);
  const estimatedCost = estimateInputCostUsd(estimatedTokens, options.pricePerMillionInputTokens);
  if (options.enabledCaps.estimated_cost_usd !== undefined && estimatedCost === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'a USD cap requires a qualified pricing record');
  }

  const required: Partial<Record<ScanCap, number | null>> = {};
  for (const key of Object.keys(options.enabledCaps) as ScanCap[]) {
    required[key] = key === 'estimated_cost_usd' ? estimatedCost
      : key === 'estimated_input_tokens' ? estimatedTokens
        : key === 'transmitted_bytes' ? estimatedBytes
          : key === 'request_attempts' ? batches.length
            : key === 'prepared_source_bytes' ? options.preparedBytes
              : key === 'candidate_files' ? options.candidateFiles
                : options.preparedFragments;
  }

  let overrun = false;
  for (const [key, cap] of Object.entries(options.enabledCaps) as [ScanCap, number][]) {
    const need = required[key];
    if (need !== null && need !== undefined && need > cap) {
      overrun = true;
    }
  }
  const rejected = overrun && options.requireFit && !options.allowPartial;

  // A partial scan admits a deterministic prefix of the planned batches, never all
  // work with its caps disabled. Preparation caps are enforced before planning.
  const admitted: EvaluationBatch[] = [];
  let tokens = 0;
  let bytes = 0;
  const fits = (cost: BatchCost): boolean => {
    const nextTokens = tokens + cost.tokens;
    const needs: Partial<Record<ScanCap, number | null>> = {
      estimated_input_tokens: nextTokens,
      transmitted_bytes: bytes + cost.bytes,
      request_attempts: admitted.length + 1,
      estimated_cost_usd: estimateInputCostUsd(nextTokens, options.pricePerMillionInputTokens),
      prepared_source_bytes: options.preparedBytes,
      candidate_files: options.candidateFiles,
      fragments: options.preparedFragments,
    };
    return !Object.entries(options.enabledCaps).some(([key, cap]) => (needs[key as ScanCap] ?? Infinity) > cap);
  };
  const admit = (batch: EvaluationBatch): void => {
    const cost = costOf(batch);
    admitted.push(batch);
    tokens += cost.tokens;
    bytes += cost.bytes;
  };
  for (const batch of batches) {
    if (fits(costOf(batch))) {
      admit(batch);
      continue;
    }
    // A partial scan may still send the longest leading part of the first batch that
    // does not fit, so a size cap smaller than one full batch still evaluates something.
    if (options.allowPartial) {
      let low = 0;
      let high = batch.items.length - 1;
      let head: EvaluationBatch | null = null;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = { ...batch, items: batch.items.slice(0, middle) };
        if (fits(costOf(candidate))) { low = middle; head = candidate; } else high = middle - 1;
      }
      if (head !== null && head.items.length === low) admit(head);
    }
    break;
  }

  return {
    batches: rejected ? [] : admitted,
    rejected,
    capReached: admitted.length < batches.length,
    report: {
      plannedRemoteFragments: fragments.length,
      plannedCacheHits: options.preparedFragments - fragments.length,
      estimatedFirstAttemptTokens: estimatedTokens,
      estimatedFirstAttemptCostUsd: estimatedCost,
      estimatedFirstAttemptRequests: batches.length,
      enabledCaps: options.enabledCaps,
      estimatedRequiredCaps: required,
    },
  };
}

/**
 * Exact measures of serialized bodies; the token counts run on the worker pool when
 * the bodies are large enough to pay for it (or `threads` names a pool explicitly).
 */
export function measureSerializedBodies(
  bodies: readonly string[], limits: BatchLimits, countQuestionTokens: (text: string) => number, threads?: number,
): SerializedBatchMeasure[] {
  const chars = bodies.reduce((total, body) => total + body.length, 0);
  const lease = threads === undefined && chars < PREPARE_POOL_MIN_BYTES ? null : acquirePool(threads, 'sync');
  try {
    const counts = countTokensWith(lease?.pool ?? null, bodies, countReferenceTokens);
    return bodies.map((body, index) => measureSerializedBatch(body, limits, countQuestionTokens, counts[index]));
  } finally {
    lease?.release();
  }
}

/** `measureSerializedBodies` without blocking the event loop: the counts are awaited from an async pool. */
export async function measureSerializedBodiesAsync(
  bodies: readonly string[], limits: BatchLimits, countQuestionTokens: (text: string) => number,
  options: { readonly threads?: number; readonly signal?: AbortSignal } = {},
): Promise<SerializedBatchMeasure[]> {
  const chars = bodies.reduce((total, body) => total + body.length, 0);
  const lease = options.threads === undefined && chars < PREPARE_POOL_MIN_BYTES ? null : acquirePool(options.threads, 'async');
  try {
    const counts = await countTokensWithAsync(lease?.pool ?? null, bodies, countReferenceTokens, options.signal);
    return bodies.map((body, index) => measureSerializedBatch(body, limits, countQuestionTokens, counts[index]));
  } finally {
    lease?.release();
  }
}

/**
 * Deterministic batches bounded by the provider's own limits: path and offset order,
 * or the caller's order when `preserveOrder` is set (a prioritized partial scan).
 *
 * Growing a batch is bounded by an upper estimate (the sum of its singleton measures,
 * state counted once), and a batch closes when the next question would push that
 * estimate over a limit, so the wire body is tokenized once per batch, after all the
 * batches are closed and in parallel. The exact measure decides: a batch that does
 * not fit sheds its tail, and the batches after it are closed again from that tail,
 * which is what closing them one at a time would have done. Closing on the estimate
 * rather than probing the exact measure at each boundary leaves batches about one
 * percent smaller for one tokenization less per batch.
 */
export type BuildBatchesOptions = {
  readonly model?: string; readonly limits?: BatchLimits; readonly serialize?: (batch: EvaluationBatch) => string;
  readonly preserveOrder?: boolean;
  readonly countQuestionTokens?: (text: string) => number;
  readonly singletonMeasures?: ReadonlyMap<string, SerializedBatchMeasure>;
  readonly onBatchMeasure?: (batch: EvaluationBatch, measure: SerializedBatchMeasure, body: string) => void;
  /** Worker threads for the token counts; default: the other cores when the scan is large. */
  readonly threads?: number;
};

export function buildBatches(fragments: readonly PreparedFragment[], query: string, options: BuildBatchesOptions = {}): EvaluationBatch[] {
  const limits = options.limits ?? batchLimits();
  const countQuestionTokens = options.countQuestionTokens ?? questionTokenMemo();
  const steps = batchingSteps(fragments, query, { ...options, limits, countQuestionTokens });
  let step = steps.next();
  while (step.done !== true) step = steps.next(measureSerializedBodies(step.value, limits, countQuestionTokens, options.threads));
  return step.value;
}

/** `buildBatches` with the token counts awaited from an async pool; `signal` aborts the wait. */
export async function buildBatchesAsync(
  fragments: readonly PreparedFragment[], query: string, options: BuildBatchesOptions & { readonly signal?: AbortSignal } = {},
): Promise<EvaluationBatch[]> {
  const limits = options.limits ?? batchLimits();
  const countQuestionTokens = options.countQuestionTokens ?? questionTokenMemo();
  const steps = batchingSteps(fragments, query, { ...options, limits, countQuestionTokens });
  let step = steps.next();
  while (step.done !== true) {
    step = steps.next(await measureSerializedBodiesAsync(step.value, limits, countQuestionTokens, {
      ...(options.threads === undefined ? {} : { threads: options.threads }), ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  }
  return step.value;
}

/** The batching algorithm; every exact measure is requested by yielding the bodies and resumed with their measures. */
function* batchingSteps(
  fragments: readonly PreparedFragment[], query: string,
  options: BuildBatchesOptions & { readonly limits: BatchLimits; readonly countQuestionTokens: (text: string) => number },
): Generator<string[], EvaluationBatch[], SerializedBatchMeasure[]> {
  const { limits, countQuestionTokens } = options;
  const serialize = options.serialize ?? ((batch) => JSON.stringify(buildRequestPayload(batch, options.model ?? 'estimate')));
  const ordered = options.preserveOrder === true ? fragments : [...fragments].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    || (left.startLine - right.startLine) || (left.endLine - right.endLine));
  const tokenBudget = limits.totalTokens * limits.headroomRatio;

  const items: BatchItem[] = ordered.map((fragment) => ({
    id: fragment.id, path: fragment.path,
    startLine: fragment.startLine, endLine: fragment.endLine,
    text: fragment.text, label: fragment.label ?? null,
  }));
  const unmeasured = items.filter((item) => options.singletonMeasures?.get(item.id) === undefined);
  const measured = unmeasured.length === 0 ? [] : yield unmeasured.map((item) => serialize({ query, items: [item] }));
  const singles = new Map<string, SerializedBatchMeasure>(unmeasured.map((item, index) => [item.id, measured[index]!]));
  const singleOf = (item: BatchItem): SerializedBatchMeasure => options.singletonMeasures?.get(item.id) ?? singles.get(item.id)!;
  for (const item of items) {
    if (!singleOf(item).fits) throw new ConfigurationError('INVALID_REQUEST', 'one question exceeds the provider context estimate');
  }
  if (items.length === 0) return [];
  const first = items[0]!;
  const statePayload = JSON.parse(serialize({ query, items: [first] })) as { state: unknown };
  const stateText = JSON.stringify(statePayload.state);
  const state = { tokens: countQuestionTokens(stateText), bytes: Buffer.byteLength(stateText, 'utf8') };

  type Closed = { readonly items: BatchItem[]; readonly end: number };
  /** Close batches on the estimate from `carried` followed by the items from index `from`. */
  const closeFrom = (carried: readonly BatchItem[], from: number): Closed[] => {
    const closed: Closed[] = [];
    let current: BatchItem[] = [...carried];
    let tokens = state.tokens;
    let bytes = state.bytes;
    for (const item of current) {
      const single = singleOf(item);
      tokens += (single.tokens ?? tokenBudget) - state.tokens;
      bytes += single.bytes - state.bytes;
    }
    for (let index = from; index < items.length; index += 1) {
      const item = items[index]!;
      const single = singleOf(item);
      const grownTokens = tokens + (single.tokens ?? tokenBudget) - state.tokens;
      const grownBytes = bytes + single.bytes - state.bytes;
      if (current.length > 0 && (current.length + 1 > limits.maxItems || grownTokens > tokenBudget || grownBytes > limits.maxRequestBytes)) {
        closed.push({ items: current, end: index - 1 });
        current = [];
        tokens = state.tokens + (single.tokens ?? tokenBudget) - state.tokens;
        bytes = state.bytes + single.bytes - state.bytes;
      } else {
        tokens = grownTokens;
        bytes = grownBytes;
      }
      current.push(item);
    }
    if (current.length > 0) closed.push({ items: current, end: items.length - 1 });
    return closed;
  };

  const batches: EvaluationBatch[] = [];
  let pending = closeFrom([], 0);
  while (pending.length > 0) {
    const bodies = pending.map((closed) => serialize({ query, items: closed.items }));
    const measures = yield bodies;
    let restart: Closed[] | null = null;
    for (let index = 0; index < pending.length; index += 1) {
      const closed = pending[index]!;
      let batchItems = closed.items;
      let body = bodies[index]!;
      let exact = measures[index]!;
      if (exact.fits || batchItems.length === 1) {
        const batch = { query, items: batchItems };
        batches.push(batch);
        options.onBatchMeasure?.(batch, exact, body);
        continue;
      }
      // The estimate let a tail through: shed it, then close what follows again from it.
      const carried: BatchItem[] = [];
      for (;;) {
        carried.unshift(batchItems[batchItems.length - 1]!);
        batchItems = batchItems.slice(0, -1);
        body = serialize({ query, items: batchItems });
        exact = measureSerializedBatch(body, limits, countQuestionTokens);
        if (exact.fits || batchItems.length === 1) break;
      }
      const batch = { query, items: batchItems };
      batches.push(batch);
      options.onBatchMeasure?.(batch, exact, body);
      restart = closeFrom(carried, closed.end + 1);
      break;
    }
    pending = restart ?? [];
  }
  return batches;
}
