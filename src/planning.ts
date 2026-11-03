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

  // A partial scan admits a deterministic prefix of whole batches, never all work
  // with its caps disabled. Preparation caps are enforced before planning.
  const admitted: EvaluationBatch[] = [];
  let tokens = 0;
  let bytes = 0;
  for (const batch of batches) {
    const cost = costOf(batch);
    const nextTokens = tokens + cost.tokens;
    const nextBytes = bytes + cost.bytes;
    const needs: Partial<Record<ScanCap, number | null>> = {
      estimated_input_tokens: nextTokens,
      transmitted_bytes: nextBytes,
      request_attempts: admitted.length + 1,
      estimated_cost_usd: estimateInputCostUsd(nextTokens, options.pricePerMillionInputTokens),
      prepared_source_bytes: options.preparedBytes,
      candidate_files: options.candidateFiles,
      fragments: options.preparedFragments,
    };
    if (Object.entries(options.enabledCaps).some(([key, cap]) => (needs[key as ScanCap] ?? Infinity) > cap)) break;
    admitted.push(batch);
    tokens = nextTokens;
    bytes = nextBytes;
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

/** Deterministic batches: path and offset order, bounded by the provider's own limits. */
export function buildBatches(fragments: readonly PreparedFragment[], query: string, options: {
  readonly model?: string; readonly limits?: BatchLimits; readonly serialize?: (batch: EvaluationBatch) => string;
  readonly countQuestionTokens?: (text: string) => number;
  readonly singletonMeasures?: ReadonlyMap<string, SerializedBatchMeasure>;
  readonly onBatchMeasure?: (batch: EvaluationBatch, measure: SerializedBatchMeasure, body: string) => void;
} = {}): EvaluationBatch[] {
  const limits = options.limits ?? batchLimits();
  const serialize = options.serialize ?? ((batch) => JSON.stringify(buildRequestPayload(batch, options.model ?? 'estimate')));
  const countQuestionTokens = options.countQuestionTokens ?? questionTokenMemo();
  const measure = (batch: EvaluationBatch): { result: SerializedBatchMeasure; body: string } => {
    const body = serialize(batch);
    return { result: measureSerializedBatch(body, limits, countQuestionTokens), body };
  };
  const ordered = [...fragments].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    || (left.startLine - right.startLine) || (left.endLine - right.endLine));
  const batches: EvaluationBatch[] = [];
  let items: BatchItem[] = [];
  let lastFit: { result: SerializedBatchMeasure; body?: string } | null = null;

  const flush = (): void => {
    if (items.length > 0) {
      const batch = { query, items };
      batches.push(batch);
      if (lastFit !== null) options.onBatchMeasure?.(batch, lastFit.result, lastFit.body ?? serialize(batch));
      items = [];
      lastFit = null;
    }
  };

  for (const fragment of ordered) {
    const item: BatchItem = {
      id: fragment.id, path: fragment.path,
      startLine: fragment.startLine, endLine: fragment.endLine,
      text: fragment.text, label: fragment.label ?? null,
    };
    const premeasured = options.singletonMeasures?.get(item.id);
    const singleton = premeasured === undefined ? measure({ query, items: [item] })
      : { result: premeasured };
    if (!singleton.result.fits) {
      throw new ConfigurationError('INVALID_REQUEST', 'one question exceeds the provider context estimate');
    }
    if (items.length > 0) {
      const candidate = measure({ query, items: [...items, item] });
      if (!candidate.result.fits) flush();
      else lastFit = candidate;
    }
    if (items.length === 0) lastFit = singleton;
    items.push(item);
  }
  flush();
  return batches;
}
