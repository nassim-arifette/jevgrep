import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Configuration } from '../../src/contracts.ts';
import type { BatchItem, EvaluationBatch, ProviderClient } from '../../src/evaluation/contracts.ts';
import { serializeConfiguredBatch } from '../../src/evaluation/provider.ts';
import { countReferenceTokens } from '../../src/response/token-counter.ts';

/**
 * Captured Jev judgments, replayed offline through the whole engine (experiment E7).
 *
 * Unlike the selection replay in `replay.ts`, which re-runs selection over one fixed
 * candidate set, this pool lets an arm choose a different candidate subset and still
 * pass through ordinary preparation, budget, freshness and rendering.
 *
 * Jev judges each fragment independently against the shared question, so a score
 * captured during one exhaustive authorized scan can stand in for the same fragment's
 * score in any candidate subset. A pool holds hashes, line ranges, scores and token
 * counts only: never source text, the full question or credentials.
 */
export const POOL_SCHEMA_VERSION = 1;

export type PoolItem = {
  readonly path: string; readonly startLine: number; readonly endLine: number;
  /** SHA-256 of the model-visible text and label. */
  readonly sha256: string;
  readonly score: number | null;
  /** Reference tokens this item adds to a batch beyond the question envelope. */
  readonly tokens: number;
};
export type PoolQuery = {
  /** SHA-256 of the exact question, so a pool cannot replay against an edited one. */
  readonly questionSha256: string;
  readonly items: PoolItem[];
  /** Reference tokens of one batch envelope with the question and no items. */
  questionTokens: number;
  requests: number; reportedInputTokens: number; unknownUsage: number; providerMs: number;
  readonly answeredModels: string[];
};
export type ScorePool = {
  readonly schemaVersion: typeof POOL_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly provider: Configuration['provider'];
  readonly search: Configuration['search'];
  /** Keyed by benchmark query id: two snapshots may share one question text. */
  readonly queries: Record<string, PoolQuery>;
};

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const itemHash = (item: Pick<BatchItem, 'text' | 'label'>): string => sha256(`${item.label ?? ''}\u0000${item.text}`);
export const itemKey = (item: { path: string; startLine: number; endLine: number; sha256: string }): string =>
  `${item.path}:${item.startLine}-${item.endLine}:${item.sha256}`;

export function emptyPool(config: Configuration): ScorePool {
  return { schemaVersion: POOL_SCHEMA_VERSION, createdAt: new Date().toISOString(), provider: config.provider, search: config.search, queries: {} };
}

export function loadPool(path: string): ScorePool {
  const pool = JSON.parse(readFileSync(path, 'utf8')) as ScorePool;
  if (pool.schemaVersion !== POOL_SCHEMA_VERSION) throw new Error(`unsupported score pool schema ${String(pool.schemaVersion)}`);
  return pool;
}

const envelope = (config: Configuration, query: string): number => countReferenceTokens(serializeConfiguredBatch(config, { query, items: [] }));

/** Record every valid score a live provider returns for one benchmark query; the provider itself is unchanged. */
export function capturingProvider(provider: ProviderClient, config: Configuration, pool: ScorePool, id: string): ProviderClient {
  return {
    model: provider.model,
    ...(provider.serializeBatch === undefined ? {} : { serializeBatch: provider.serializeBatch }),
    async evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal, preparedBody?: string) {
      const questionTokens = envelope(config, batch.query);
      const entry = pool.queries[id] ??= {
        questionSha256: sha256(batch.query), items: [], questionTokens, requests: 0, reportedInputTokens: 0, unknownUsage: 0, providerMs: 0, answeredModels: [],
      };
      const started = performance.now();
      entry.requests += 1;
      try {
        const result = await provider.evaluateBatch(batch, signal, preparedBody);
        if (result.usage.inputTokens === null) entry.unknownUsage += 1;
        else entry.reportedInputTokens += result.usage.inputTokens;
        if (result.returnedModel !== null && !entry.answeredModels.includes(result.returnedModel)) entry.answeredModels.push(result.returnedModel);
        for (const item of batch.items) {
          const score = result.scores.get(item.id);
          const record = {
            path: item.path, startLine: item.startLine, endLine: item.endLine, sha256: itemHash(item), score: score ?? null,
            tokens: Math.max(0, countReferenceTokens(serializeConfiguredBatch(config, { query: batch.query, items: [item] })) - questionTokens),
          };
          const at = entry.items.findIndex((other) => itemKey(other) === itemKey(record));
          if (at === -1) entry.items.push(record);
          else if (at !== -1 && score !== undefined) entry.items[at] = record;
        }
        return result;
      } catch (cause) {
        entry.unknownUsage += 1;
        throw cause;
      } finally {
        entry.providerMs += performance.now() - started;
      }
    },
  };
}

export type ReplayAccount = { requests: number; missing: number; masked: number; evaluated: number };

/**
 * Answers from a pool. Fragments outside `candidates` receive score 0, so the engine's
 * ordinary selection, budget and freshness logic only ever returns candidate excerpts.
 * Their "evaluation" is free and must not be counted as Jev work; callers account for
 * candidate cost separately. A candidate with no captured score is left unanswered.
 */
export function replayProvider(pool: ScorePool, entry: PoolQuery, config: Configuration, candidates: ReadonlySet<string> | null): { provider: ProviderClient; account: ReplayAccount } {
  const account: ReplayAccount = { requests: 0, missing: 0, masked: 0, evaluated: 0 };
  const provider: ProviderClient = {
    model: pool.provider.model,
    serializeBatch: (batch) => serializeConfiguredBatch(config, batch),
    async evaluateBatch(batch) {
      account.requests += 1;
      if (sha256(batch.query) !== entry.questionSha256) throw new Error('replayed question differs from the captured one');
      const scores = new Map<string, number>();
      const byKey = new Map(entry.items.map((item) => [itemKey(item), item.score]));
      for (const item of batch.items) {
        const key = itemKey({ path: item.path, startLine: item.startLine, endLine: item.endLine, sha256: itemHash(item) });
        if (candidates !== null && !candidates.has(key)) { scores.set(item.id, 0); account.masked += 1; continue; }
        const score = byKey.get(key);
        if (score === undefined || score === null) { account.missing += 1; continue; }
        scores.set(item.id, score);
        account.evaluated += 1;
      }
      return {
        scores, invalid: [], usage: { inputTokens: 0, outputTokens: 0 },
        requestedModel: pool.provider.model, returnedModel: entry.answeredModels[0] ?? null,
        transmittedBytes: 0, requestId: null,
      };
    },
  };
  return { provider, account };
}

/** Estimated Jev input for evaluating `items` alone, batched like the engine (≤64 items, ≤22,400 tokens). */
export function candidateCost(entry: PoolQuery, items: readonly PoolItem[], target = 22_400, maxItems = 64) {
  let batches = 0; let tokens = 0; let open = 0; let count = 0;
  for (const item of items) {
    if (count === 0 || count >= maxItems || open + item.tokens > target - entry.questionTokens) { batches += 1; open = 0; count = 0; tokens += entry.questionTokens; }
    open += item.tokens; count += 1; tokens += item.tokens;
  }
  return { batches, tokens };
}
