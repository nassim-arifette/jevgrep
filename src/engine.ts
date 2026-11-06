/**
 * The shared search engine (JG-014).
 *
 * One path — question, files, fragments, cache, evaluations, selection, freshness,
 * measured response — used by the CLI and by MCP alike (requirement R10). The
 * adapters validate input and present output; they never re-implement any of this.
 *
 * Two stages are deliberately marked as seams for their owning issues, and both are
 * implemented here in their honest minimal form so the path is complete and testable:
 * `planScan` (JG-016: optional caps, reservations, rate card; in planning.ts) and `runEvaluations`
 * (JG-017: batching, retries, cancellation). Filling them in must not add a second
 * engine; it replaces the body of one function.
 *
 * Invariants the engine is responsible for:
 * - a rejection or an early failure dispatches nothing;
 * - a provider failure is never a score, and a missing usage is never zero;
 * - counters follow specification section 4.2 and are checked by the contract
 *   validator on every response;
 * - `scope_fully_scanned` is asserted only when preparation finished and every
 *   fragment has a validated evaluation.
 */
import { createHash } from 'node:crypto';
import {
  ContractValidationError, createSearchError, parseSearchRequest,
} from './contracts.ts';
import type { ErrorCode, ScanCap, SearchOutcome, StopReason } from './contracts.ts';
import { ConfigurationError, resolveCredential } from './config.ts';
import type { LoadedConfiguration } from './config.ts';
import { ScoreCache, evaluationIdentity, isPinnedModelRevision } from './evaluation/cache.ts';
import type { ScoreCacheWrite } from './evaluation/cache.ts';
import { ProviderError } from './evaluation/contracts.ts';
import { CRITERION_VERSION, LAYOUT_VERSION, buildRequestPayload } from './evaluation/jev.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from './evaluation/contracts.ts';
import { createConfiguredProvider } from './evaluation/provider.ts';
import { batchLimits, isOpenRouterModelRevision, scoreCachePolicy, MAX_ROLLING_TTL_SECONDS, type SerializedBatchMeasure } from './evaluation/policy.ts';
import { runEvaluations } from './evaluation/scheduler.ts';
import { SearchContext, SearchLogger, isAbortError, runPhase, systemClock } from './lifecycle.ts';
import type { Clock } from './lifecycle.ts';
import { batchCost, buildBatchesAsync, enabledCapsOf, measureSerializedBodiesAsync, planScan, questionTokenMemo } from './planning.ts';
import type { BatchCost, ScanPlan } from './planning.ts';
import { PARTIAL_SCAN_ORDER, prioritizeFiles, prioritizeFragments, type CandidateOrder } from './priority.ts';
import { estimateInputCostUsd } from './pricing.ts';
import { excerptBudget, excerptCost, renderSearchResult, ResponseBudgetError } from './response/render.ts';
import type { ReportInputs, RenderedResponse } from './response/render.ts';
import { CANDIDATE_POOL_VERSION } from './response/candidate-pool.ts';
import type { CandidatePool } from './response/candidate-pool.ts';
import { selectRanges } from './response/selection.ts';
import type { Candidate, SelectedRange, SelectionResult } from './response/selection.ts';
import {
  ContinuationError, bindingDigest, decodeContinuation, deliveredKey, encodeContinuation, type ContinuationState,
} from './continuation.ts';
import { REFERENCE_COUNTER_ID } from './response/token-counter.ts';
import { UnauthorizedPathError } from './source/authorization.ts';
import type { AuthorizedRoot } from './source/authorization.ts';
import type { PreparedFragment, SnapshotChunker } from './source/chunker.ts';
import { FreshnessTracker, rootReader } from './source/freshness.ts';
import { exclusionCounts, prepareScopeCooperatively } from './source/prepare.ts';
import { PreparationCache, preparationCacheDirectory } from './source/preparation-cache.ts';
import type { PreparedScope, PrepareOptions } from './source/prepare.ts';
import type { SourceSnapshot } from './source/snapshot.ts';
import { countProfile, measureAsync, measureSync, withSearchProfile, type SearchProfiler } from './profiling.ts';

/** A caller's request that the shared contract refused. */
export class RequestValidationError extends Error {
  override readonly name = 'RequestValidationError';

  constructor(cause: ContractValidationError) {
    super(cause.message, { cause });
  }
}

export type EngineOptions = {
  readonly configuration: LoadedConfiguration;
  /** Inject a provider adapter for deterministic or offline execution. */
  readonly provider?: ProviderClient;
  readonly cache?: ScoreCache;
  /** Content-verified preparation reuse; defaults to a bounded store beside the score cache. */
  readonly preparationCache?: PreparationCache;
  /** Benchmark seam for chunking experiments (E1); defaults to the production chunker. */
  readonly chunker?: SnapshotChunker;
  /** Evaluation and preparation order of an allowed partial scan (section 10); a complete scan is unaffected. */
  readonly candidateOrder?: CandidateOrder;
  readonly clock?: Clock;
  readonly logger?: SearchLogger;
  readonly env?: NodeJS.ProcessEnv;
};

/** A step of one search a caller may show while it waits; counts are local facts, never estimates of quality. */
export type SearchProgress = {
  readonly phase: 'preparation' | 'evaluation' | 'selection';
  /** Fragments whose score is known (remote or cache) over the fragments to evaluate; null before planning. */
  readonly evaluated: number;
  readonly total: number | null;
  readonly cacheReused: number;
  readonly files: number;
  readonly message: string;
};

export type SearchInvocation = {
  /** Optional local measurements; never serialized into the search response. */
  readonly profile?: SearchProfiler;
  /** Progress of a search, phase by phase and batch by batch; for a client's progress notifications. */
  readonly onProgress?: (progress: SearchProgress) => void;
  /** Client cancellation: after it, no new result is emitted for this call. */
  readonly signal?: AbortSignal;
  readonly searchId?: string;
  /** Trusted local admission time; never taken from tool arguments. */
  readonly startedAtMs?: number;
  /**
   * Prepared scopes shared by the questions of one multiquestion call, keyed by scope.
   * Preparation is local; every question still pays for its own remote evaluations.
   */
  readonly preparations?: Map<string, PreparedScope>;
  /** Local benchmark capture of the evaluated candidates; never part of the response. */
  readonly onCandidatePool?: (pool: CandidatePool) => void;
};

export type SearchOutcomeWithDiagnostics = {
  readonly outcome: SearchOutcome;
  /** Local-only detail: never part of the bounded payload. */
  readonly measuredTokens: number | null;
  readonly searchId: string;
};

type Scored = { readonly fragment: PreparedFragment; readonly score: number; readonly fromCache: boolean };

type UsageAccount = {
  attempts: number;
  knownInputTokens: number;
  /** Conservative reservation kept for attempts whose usage never became known. */
  reservedInputTokens: number;
  unknownUsageAttempts: number;
  transmittedBytes: number;
};

export class SearchEngine {
  readonly #options: EngineOptions;
  readonly #cache: ScoreCache;
  readonly #preparationCache: PreparationCache;

  constructor(options: EngineOptions) {
    this.#options = options;
    const { config, cacheDirectory } = options.configuration;
    this.#cache = options.cache ?? new ScoreCache({
      directory: cacheDirectory,
      enabled: config.cache.enabled,
      ttlSeconds: config.cache.ttl_seconds,
      rollingTtlSeconds: config.cache.rolling_ttl_seconds ?? MAX_ROLLING_TTL_SECONDS,
      maxBytes: config.cache.max_bytes,
    });
    this.#preparationCache = options.preparationCache ?? new PreparationCache({
      directory: preparationCacheDirectory(cacheDirectory),
      enabled: config.cache.enabled,
      maxBytes: config.cache.max_bytes,
    });
  }

  get preparationCache(): PreparationCache {
    return this.#preparationCache;
  }

  get cache(): ScoreCache {
    return this.#cache;
  }

  get clock(): Clock {
    return this.#options.clock ?? systemClock;
  }

  /** Run one search. Never throws for caller input: it returns a contract outcome. */
  async search(request: unknown, invocation: SearchInvocation = {}): Promise<SearchOutcomeWithDiagnostics> {
    return withSearchProfile(invocation.profile, () => this.#search(request, invocation));
  }

  /**
   * Several questions over shared local preparation (roadmap section 13). Each question
   * is a separate search with its own result, deadline and remote evaluations; only
   * inventory and preparation of an identical scope are shared.
   */
  async searchMany(
    requests: readonly unknown[], invocation: Pick<SearchInvocation, 'profile' | 'signal' | 'onProgress'> = {},
  ): Promise<SearchOutcomeWithDiagnostics[]> {
    const preparations = new Map<string, PreparedScope>();
    const outcomes: SearchOutcomeWithDiagnostics[] = [];
    for (const [index, request] of requests.entries()) {
      const onProgress = invocation.onProgress;
      outcomes.push(await this.search(request, {
        ...invocation, preparations,
        ...(onProgress === undefined ? {} : { onProgress: (progress: SearchProgress) => {
          onProgress({ ...progress, message: `question ${String(index + 1)} of ${String(requests.length)}: ${progress.message}` });
        } }),
      }));
    }
    return outcomes;
  }

  async #search(request: unknown, invocation: SearchInvocation): Promise<SearchOutcomeWithDiagnostics> {
    const { config } = this.#options.configuration;
    const context = new SearchContext({
      ...(invocation.searchId === undefined ? {} : { searchId: invocation.searchId }),
      clock: this.clock,
      ...(invocation.startedAtMs === undefined ? {} : { startedAtMs: invocation.startedAtMs }),
      deadlineMs: requestedDeadline(request, config.search.deadline_ms),
      ...(invocation.signal === undefined ? {} : { clientSignal: invocation.signal }),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
    });

    try {
      return await this.#run(request, context, invocation);
    } catch (cause) {
      const code = errorCodeOf(cause);
      if (code === null) {
        throw cause;
      }
      return { outcome: createSearchError(code, context.searchId), measuredTokens: null, searchId: context.searchId };
    } finally {
      await context.dispose();
    }
  }

  async #run(rawRequest: unknown, context: SearchContext, invocation: SearchInvocation): Promise<SearchOutcomeWithDiagnostics> {
    const { onCandidatePool: capture, preparations } = invocation;
    const { config, sourceRoot } = this.#options.configuration;
    const request = parseCallerRequest(rawRequest, config);

    // The mandatory report envelope is reserved before any work that could cost money.
    const available = measureSync('rendering', () => excerptBudget(context.searchId, request.scope, REFERENCE_COUNTER_ID, request.max_context_tokens));

    const provider = this.#options.provider ?? createConfiguredProvider(
      config,
      resolveCredential(this.#options.configuration, this.#options.env ?? process.env),
    );

    const root = sourceRoot;
    const order = this.#options.candidateOrder ?? PARTIAL_SCAN_ORDER;
    const partialOrder = request.allow_partial_scan && order.kind !== 'path' ? order : null;
    const fileOrder: PrepareOptions['fileOrder'] = partialOrder === null ? undefined
      : (files) => prioritizeFiles(files, request.query, partialOrder);
    const prepared = await this.#preparedFor(request.scope, context, fileOrder, preparations);

    // Cache lookup precedes planning and scheduling (specification section 6.3).
    const model = provider.model;
    const continuation = continuationOf(request, model, config);
    const adapter = config.provider.adapter ?? 'typesafe-direct';
    const cachePolicy = scoreCachePolicy(adapter, model, config.cache);
    const serialize = (batch: EvaluationBatch): string => measureSync('serialization', () => {
      const payload = provider.serializeBatch?.(batch) ?? JSON.stringify(buildRequestPayload(batch, model));
      countProfile('serializedQuestions', batch.items.length);
      countProfile('serializedBytes', () => Buffer.byteLength(payload, 'utf8'));
      return payload;
    });
    const { costOf, onBatchMeasure } = batchCostMemo(model, serialize);
    const limits = batchLimits(adapter);
    const countQuestionTokens = questionTokenMemo();
    const { cached, pending, identities, singletonMeasures } = await this.#lookupCachedScores(prepared.fragments, {
      query: request.query, serialize, limits, countQuestionTokens, signal: context.signal,
      identity: { endpoint: config.provider.base_url, model, adapter, cacheMode: cachePolicy.mode },
    });
    const progress = (phase: SearchProgress['phase'], evaluated: number, message: string): void => {
      invocation.onProgress?.({ phase, evaluated, total: prepared.fragments.length, cacheReused: cached.size, files: prepared.files.length, message });
    };
    progress('preparation', cached.size, `${String(prepared.files.length)} files prepared, ${String(prepared.fragments.length)} fragments, ${String(cached.size)} scores from cache`);
    const batchesOf = (fragments: readonly PreparedFragment[], preserveOrder: boolean): Promise<EvaluationBatch[]> =>
      measureAsync('batching', () => buildBatchesAsync(fragments, request.query, {
        model, serialize, limits, countQuestionTokens, singletonMeasures, onBatchMeasure, preserveOrder, signal: context.signal,
      }));
    const pendingBatches = await batchesOf(pending, false);
    if (this.#cache.stats.corrupt > 0 || this.#cache.stats.failures > 0) {
      context.diagnostics.record('CACHE_UNAVAILABLE', context.elapsedMs,
        { count: this.#cache.stats.corrupt + this.#cache.stats.failures });
    }

    const pricePerMillion = config.provider.pricing?.input_usd_per_million_tokens ?? null;
    if (request.max_cost_usd !== undefined && pricePerMillion === null) {
      throw new RequestValidationError(new ContractValidationError('$.max_cost_usd', 'a cost budget needs a pricing record for the configured model'));
    }
    const enabledCaps = withRequestBudget(enabledCapsOf(config.scan_caps), request);
    const planOf = (batches: readonly EvaluationBatch[]): ScanPlan => measureSync('planning', () => planScan(pending, request.query, {
      model,
      batches,
      serialize,
      batchCost: costOf,
      enabledCaps,
      allowPartial: request.allow_partial_scan,
      requireFit: config.search.require_fit,
      preparedBytes: prepared.preparedBytes,
      candidateFiles: prepared.files.length,
      preparedFragments: prepared.fragments.length,
      pricePerMillionInputTokens: pricePerMillion,
    }));
    let plan = planOf(pendingBatches);
    // An allowed partial scan evaluates the highest-priority prefix instead of a path
    // prefix. The strict preflight already ran on the complete plan.
    if (plan.capReached && !plan.rejected && partialOrder !== null) {
      plan = planOf(await batchesOf(prioritizeFragments(pending, request.query, partialOrder), true));
    }

    const usage: UsageAccount = {
      attempts: 0, knownInputTokens: 0, reservedInputTokens: 0, unknownUsageAttempts: 0, transmittedBytes: 0,
    };
    const byId = new Map(prepared.fragments.map((fragment) => [fragment.id, fragment]));
    const scored: Scored[] = [];
    for (const [id, score] of cached) {
      const fragment = byId.get(id);
      if (fragment !== undefined) {
        scored.push({ fragment, score, fromCache: true });
      }
    }

    if (plan.rejected || (context.stopReasons().includes('PREPARATION_LIMIT')
      && config.search.require_fit && !request.allow_partial_scan)) {
      context.addStopReason('SCOPE_EXCEEDS_SCAN_BUDGET');
      return this.#render(context, request, prepared, [], usage, plan, available, true, continuation);
    }
    if (plan.capReached) context.addStopReason('SCAN_CAP_REACHED');

    if (plan.batches.length > 0) {
      const planned = plan.batches.reduce((total, batch) => total + batch.items.length, 0);
      let evaluated = 0;
      await this.#evaluate(provider, plan.batches, context, {
        root, usage, enabledCaps, pricePerMillion, costOf, byId, scored, identities, model,
        cacheMode: cachePolicy.mode, adapter,
        onBatch: (batch) => {
          evaluated += batch.items.length;
          progress('evaluation', cached.size + evaluated, `${String(evaluated)} of ${String(planned)} fragments evaluated`);
        },
      });
    }
    progress('selection', scored.length, `selecting excerpts among ${String(scored.length)} scored fragments`);

    return this.#render(context, request, prepared, scored, usage, plan, available, false, continuation, capture === undefined ? undefined : (inputs) => {
      capture(candidatePool(request, inputs, scored, available, config.search.threshold, { adapter, model }));
    });
  }

  /** Provider dispatch: admission, score collection and usage settlement per batch. */
  async #evaluate(provider: ProviderClient, batches: readonly EvaluationBatch[], context: SearchContext, state: {
    readonly root: AuthorizedRoot;
    readonly usage: UsageAccount;
    readonly enabledCaps: Partial<Record<ScanCap, number>>;
    readonly pricePerMillion: number | null;
    readonly costOf: (batch: EvaluationBatch) => BatchCost;
    readonly byId: ReadonlyMap<string, PreparedFragment>;
    readonly scored: Scored[];
    readonly identities: ReadonlyMap<string, string>;
    readonly model: string;
    readonly adapter: string;
    readonly cacheMode: string;
    readonly onBatch?: (batch: EvaluationBatch) => void;
  }): Promise<void> {
    const { config } = this.#options.configuration;
    const { root, usage, enabledCaps, pricePerMillion, costOf, byId, scored, identities, model, adapter, cacheMode } = state;
  await measureAsync('evaluation', () => runPhase(context, 'evaluation', async () => {
    await runEvaluations(provider, batches, context, {
      concurrency: config.search.concurrency,
      ...(config.search.retry === undefined ? {} : { retry: config.search.retry }),
      bodyOf: (batch) => costOf(batch).body,
      onDispatch: (batch) => admitBatch(batch, costOf(batch), { root, usage, enabledCaps, pricePerMillion, context }),
      onScores: (batch, evaluation) => {
        this.#recordScores(batch, evaluation, {
          byId, scored, identities, model,
          cacheable: isCacheableEvaluation(evaluation, model, adapter, cacheMode),
        });
        recordUsage(usage, evaluation.usage.inputTokens, Math.max(1, costOf(batch).tokens), {
          enabledCaps, pricePerMillion, context,
        });
        if (evaluation.invalid.length > 0) {
          context.addStopReason('INVALID_PROVIDER_RESPONSE');
          context.diagnostics.record('INVALID_PROVIDER_RESPONSE', context.elapsedMs, { count: evaluation.invalid.length });
        }
        state.onBatch?.(batch);
      },
      onFailure: (batch, failure, willRetry) => {
        usage.unknownUsageAttempts += 1;
        context.addStopReason('USAGE_UNKNOWN');
        if (!willRetry && (!failure.cancelled || context.stop === null)) context.addStopReason(failure.code);
        context.diagnostics.record(failure.code, context.elapsedMs, { count: batch.items.length });
      },
    });
  }));
  }

  /**
   * Both evaluation APIs judge each question independently against shared state.
   * Hash its exact envelope and regroup only misses; neighbors cannot invalidate it.
   */
  async #lookupCachedScores(fragments: readonly PreparedFragment[], options: {
    readonly query: string;
    readonly serialize: (batch: EvaluationBatch) => string;
    readonly limits: ReturnType<typeof batchLimits>;
    readonly countQuestionTokens: ReturnType<typeof questionTokenMemo>;
    readonly identity: IdentityScope;
    readonly signal?: AbortSignal;
  }): Promise<{
    cached: Map<string, number>;
    pending: PreparedFragment[];
    identities: Map<string, string>;
    singletonMeasures: Map<string, SerializedBatchMeasure>;
  }> {
    const { query, serialize, limits, countQuestionTokens } = options;
    const cached = new Map<string, number>();
    const pending: PreparedFragment[] = [];
    const identities = new Map<string, string>();
    const singletonMeasures = new Map<string, SerializedBatchMeasure>();
    const bodies: string[] = [];
    for (const fragment of fragments) {
      const hit = measureSync('cache_lookup', () => {
        const body = serialize({ query, items: [fragment] });
        const inputHash = createHash('sha256').update(body).digest('hex');
        const identity = fragmentIdentity(query, fragment, inputHash, options.identity);
        identities.set(fragment.id, identity);
        const score = options.identity.cacheMode !== 'disabled' ? this.#cache.read(identity) : null;
        if (score === null) bodies.push(body);
        return score;
      });
      if (hit !== null) cached.set(fragment.id, hit);
      else pending.push(fragment);
    }
    const measures = await measureAsync('batching', () => measureSerializedBodiesAsync(bodies, limits, countQuestionTokens, options.signal === undefined ? {} : { signal: options.signal }));
    pending.forEach((fragment, index) => { singletonMeasures.set(fragment.id, measures[index]!); });
    return { cached, pending, identities, singletonMeasures };
  }

  /** Collect a batch's scores and cache the ones a pinned model produced. */
  #recordScores(batch: EvaluationBatch, evaluation: BatchEvaluation, target: {
    readonly byId: ReadonlyMap<string, PreparedFragment>;
    readonly scored: Scored[];
    readonly identities: ReadonlyMap<string, string>;
    readonly model: string;
    readonly cacheable: boolean;
  }): void {
    const writes: ScoreCacheWrite[] = [];
    for (const item of batch.items) {
      const score = evaluation.scores.get(item.id);
      const fragment = target.byId.get(item.id);
      if (score === undefined || fragment === undefined) continue;
      target.scored.push({ fragment, score, fromCache: false });
      if (target.cacheable) {
        writes.push({ identity: target.identities.get(fragment.id)!, score, meta: {
          modelRevision: target.model,
          layout: LAYOUT_VERSION, criterion: CRITERION_VERSION, chunker: fragment.chunker,
        } });
      }
    }
    if (writes.length > 0) measureSync('cache_write', () => this.#cache.writeMany(writes));
  }

  /**
   * A complete preparation of the same scope is reused across the questions of one
   * call. An incomplete one stopped at a prefix ordered for another question, so a
   * question with its own priority order prepares again.
   */
  async #preparedFor(
    scope: readonly string[], context: SearchContext, fileOrder: PrepareOptions['fileOrder'],
    preparations: Map<string, PreparedScope> | undefined,
  ): Promise<PreparedScope> {
    const key = JSON.stringify(scope);
    const shared = preparations?.get(key);
    if (shared !== undefined && (shared.complete || fileOrder === undefined)) {
      this.#options.configuration.sourceRoot.assertCurrent();
      recordPreparation(shared, context);
      return shared;
    }
    const prepared = await this.#prepare(scope, context, fileOrder);
    if (preparations !== undefined && (prepared.complete || fileOrder === undefined)) preparations.set(key, prepared);
    return prepared;
  }

  /** Inventory and preparation, with their stop reasons and diagnostics recorded. */
  async #prepare(scope: readonly string[], context: SearchContext, fileOrder?: PrepareOptions['fileOrder']): Promise<PreparedScope> {
    const { config, sourceRoot: root } = this.#options.configuration;
    const prepared = await measureAsync('preparation', () => runPhase(context, 'preparation', () => prepareScopeCooperatively(root, scope, {
      inventory: {
        respectGitignore: config.source.respect_gitignore,
        maxFileBytes: config.source.max_file_bytes,
        extraDenyGlobs: config.source.extra_deny_globs,
        shouldStop: () => !context.canStartWork(),
      },
      limits: {
        preparedSourceBytes: config.scan_caps.prepared_source_bytes,
        candidateFiles: config.scan_caps.candidate_files,
        fragments: config.scan_caps.fragments,
      },
      shouldStop: () => !context.canStartWork(),
      cache: this.#preparationCache,
      ...(this.#options.chunker === undefined ? {} : { chunker: this.#options.chunker }),
      ...(fileOrder === undefined ? {} : { fileOrder }),
    })));

    // A lost authorization cannot become permission to send an earlier partial
    // snapshot. The anchor is retained and invalidation lasts until config reload.
    root.assertCurrent();
    recordPreparation(prepared, context);
    return prepared;
  }

  /** Selection, freshness and the measured rendering, in that order. */
  #render(
    context: SearchContext,
    request: { query: string; scope: string[]; max_context_tokens: number; allow_partial_scan: boolean },
    prepared: PreparedScope,
    scored: readonly Scored[],
    usage: UsageAccount,
    plan: ScanPlan,
    availableTokens: number,
    rejected: boolean,
    continuation: Continuation | null,
    capture?: (inputs: ReportInputs) => void,
  ): SearchOutcomeWithDiagnostics {
    const { config } = this.#options.configuration;
    const snapshots = new Map<string, SourceSnapshot>();
    for (const file of prepared.files) {
      snapshots.set(file.snapshot.relativePath, file.snapshot);
    }
    const freshness = new FreshnessTracker(rootReader(
      this.#options.configuration.sourceRoot, config.source.max_file_bytes,
    ));

    const delivered = continuation?.state?.delivered;
    const candidates = scored.map(({ fragment, score }) => ({ fragment, score }))
      .filter(({ fragment, score }) => delivered === undefined || score < config.search.threshold
        || !delivered.has(deliveredKey(fragment)));
    const previouslyDelivered = scored.length - candidates.length;
    const sliceLines = (path: string, startLine: number, endLine: number): string | null => {
      const snapshot = snapshots.get(path);
      return snapshot === undefined ? null : snapshot.sliceLines(startLine, endLine).text;
    };

    const select = () => measureSync('selection', () => selectRanges(candidates, {
      threshold: config.search.threshold,
      availableTokens,
      measure: excerptCost,
      sliceLines,
      unavailablePaths: freshness.unavailablePaths,
      policy: config.search.selection_policy ?? 'relevance',
      wholeDeclarations: true,
    }));
    const selection = selectFresh(select, { freshness, snapshots, rounds: prepared.files.length + 1, context });

    const inputs: ReportInputs = {
      ...reportInputs({ context, request, prepared, scored, usage, plan, selection, freshness, rejected,
        threshold: config.search.threshold,
        pricePerMillion: config.provider.pricing?.input_usd_per_million_tokens ?? null,
        previouslyDelivered,
      }),
      ...(continuation === null ? {} : { continuation: {
        previouslyDelivered,
        next: (ranges: readonly SelectedRange[]) => encodeContinuation(continuation.binding,
          deliveredAfter(delivered, candidates, ranges, config.search.threshold)),
      } }),
    };

    capture?.(inputs);
    const representedFor = (ranges: readonly SelectedRange[]): number => countRepresented(candidates, ranges, config.search.threshold, freshness.unavailablePaths);
    const rendered: RenderedResponse = measureSync('rendering', () => renderSearchResult(inputs, rejected ? [] : selection.ranges, representedFor));
    context.diagnostics.setResponseTokensMeasured(rendered.measuredTokens);
    context.logger.log('info', context.searchId, 'search.complete', {
      status: rendered.result.status,
      excerpts: rendered.result.excerpts.length,
      response_tokens: rendered.measuredTokens,
      attempts: usage.attempts,
    });
    return { outcome: rendered.result, measuredTokens: rendered.measuredTokens, searchId: context.searchId };
  }
}

/** Memoized batch costs; batching hands over measured bodies within a 16 MiB retention budget. */
function batchCostMemo(model: string, serialize: (batch: EvaluationBatch) => string): {
  costOf: (batch: EvaluationBatch) => BatchCost;
  onBatchMeasure: (batch: EvaluationBatch, measure: SerializedBatchMeasure, body: string) => void;
} {
  const measuredBatches = new WeakMap<EvaluationBatch, BatchCost>();
  let retainedPayloadBytes = 0;
  const maxRetainedPayloadBytes = 16 * 1024 * 1024;
  return {
    costOf: (batch) => {
      let cost = measuredBatches.get(batch);
      if (cost === undefined) {
        cost = batchCost(batch, model, serialize);
        measuredBatches.set(batch, cost);
      }
      return cost;
    },
    onBatchMeasure: (batch, measure, body) => {
      const retain = retainedPayloadBytes + measure.bytes <= maxRetainedPayloadBytes;
      if (retain) retainedPayloadBytes += measure.bytes;
      measuredBatches.set(batch, { tokens: measure.tokens!, bytes: measure.bytes, ...(retain ? { body } : {}) });
    },
  };
}

type IdentityScope = {
  readonly endpoint: string;
  readonly model: string;
  readonly adapter: string;
  readonly cacheMode: string;
};

function recordPreparation(prepared: PreparedScope, context: SearchContext): void {
  if (!prepared.inventory.complete) {
    context.addStopReason('INVENTORY_INCOMPLETE');
  }
  if (prepared.inventory.complete && !prepared.complete) {
    context.addStopReason('PREPARATION_LIMIT');
  }
  for (const directory of prepared.inventory.excludedDirectories) {
    context.diagnostics.recordExcludedDirectory(directory.reason);
  }
  if (prepared.parseFallbacks > 0) {
    context.diagnostics.record('PARSE_FALLBACK', context.elapsedMs, { count: prepared.parseFallbacks });
  }
}

type Continuation = { readonly binding: Buffer; readonly state: ContinuationState | null };

/**
 * Continuation state of a request, or null when scores are not cached: without the
 * cache a continued search would evaluate everything again, so none is offered.
 */
/** The operator's caps, lowered to the budgets of this call; a budget never raises a cap. */
function withRequestBudget(
  caps: Partial<Record<ScanCap, number>>, request: { readonly max_input_tokens?: number; readonly max_cost_usd?: number },
): Partial<Record<ScanCap, number>> {
  const lowered = { ...caps };
  if (request.max_input_tokens !== undefined) lowered.estimated_input_tokens = Math.min(caps.estimated_input_tokens ?? Infinity, request.max_input_tokens);
  if (request.max_cost_usd !== undefined) lowered.estimated_cost_usd = Math.min(caps.estimated_cost_usd ?? Infinity, request.max_cost_usd);
  return lowered;
}

/** The search deadline, shortened to the call's `max_search_ms` when it names one; the request is validated later. */
function requestedDeadline(request: unknown, configuredMs: number): number {
  const hinted = typeof request === 'object' && request !== null ? (request as { max_search_ms?: unknown }).max_search_ms : undefined;
  return typeof hinted === 'number' && Number.isFinite(hinted) && hinted >= 1 ? Math.min(configuredMs, Math.floor(hinted)) : configuredMs;
}

function continuationOf(
  request: ReturnType<typeof parseCallerRequest>, model: string, config: LoadedConfiguration['config'],
): Continuation | null {
  const adapter = config.provider.adapter ?? 'typesafe-direct';
  const cached = scoreCachePolicy(adapter, model, config.cache).mode !== 'disabled';
  if (!cached) {
    if (request.continuation === undefined) return null;
    throw new RequestValidationError(new ContractValidationError('$.continuation',
      'continuation needs the score cache, which is disabled for this provider profile'));
  }
  const binding = bindingDigest({
    query: request.query, scope: request.scope, adapter, endpoint: config.provider.base_url, model,
    threshold: config.search.threshold, selectionPolicy: config.search.selection_policy ?? 'relevance',
    versions: { criterion: CRITERION_VERSION, layout: LAYOUT_VERSION },
  });
  if (request.continuation === undefined) return { binding, state: null };
  try {
    return { binding, state: decodeContinuation(request.continuation, binding) };
  } catch (cause) {
    if (!(cause instanceof ContinuationError)) throw cause;
    throw new RequestValidationError(new ContractValidationError('$.continuation', cause.message));
  }
}

/** Earlier deliveries plus every qualifying fragment the given ranges represent. */
function deliveredAfter(
  previous: ReadonlySet<string> | undefined, candidates: readonly Candidate[],
  ranges: readonly SelectedRange[], threshold: number,
): Set<string> {
  const keys = new Set(previous ?? []);
  for (const { fragment, score } of candidates) {
    if (score < threshold) continue;
    if (ranges.some((range) => range.path === fragment.path && range.sha256 === fragment.sha256
      && range.startLine <= fragment.startLine && fragment.endLine <= range.endLine)) {
      keys.add(deliveredKey(fragment));
    }
  }
  return keys;
}

function parseCallerRequest(rawRequest: unknown, config: LoadedConfiguration['config']) {
  try {
    return parseSearchRequest(rawRequest, {
      default_response_tokens: config.search.default_response_tokens,
      max_response_tokens: config.search.max_response_tokens,
    });
  } catch (cause) {
    // Only a caller's request can be an invalid request; a contract failure later
    // in the pipeline is a defect and must stay loud rather than masquerade as one.
    throw cause instanceof ContractValidationError ? new RequestValidationError(cause) : cause;
  }
}

function fragmentIdentity(query: string, fragment: PreparedFragment, batchHash: string, scope: IdentityScope): string {
  return evaluationIdentity({
    query,
    path: fragment.path,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
    text: fragment.text,
    label: fragment.label ?? null,
    criterionVersion: CRITERION_VERSION,
    layoutVersion: LAYOUT_VERSION,
    chunkerVersion: fragment.chunker,
    endpoint: scope.endpoint,
    modelRevision: scope.model,
    providerOptions: { adapter: scope.adapter, cachePolicy: scope.cacheMode },
    batchComposition: [batchHash],
  });
}

/** Last checks before a batch leaves the machine, then its synchronous reservation. */
function admitBatch(batch: EvaluationBatch, cost: BatchCost, state: {
  readonly root: AuthorizedRoot;
  readonly usage: UsageAccount;
  readonly enabledCaps: Partial<Record<ScanCap, number>>;
  readonly pricePerMillion: number | null;
  readonly context: SearchContext;
}): boolean {
  const { root, usage, context } = state;
  root.assertCurrent();
  // Revalidate each named entry before disclosure, while sending only the already
  // captured snapshot bytes (never reread replacement text).
  for (const path of new Set(batch.items.map((item) => item.path))) {
    if (root.resolveEntry(path).kind !== 'file') {
      throw new UnauthorizedPathError('not_regular_file', path, 'source type changed before dispatch');
    }
  }
  const tokens = Math.max(1, cost.tokens);
  const bytes = cost.bytes;
  if (exceedsEnabledCaps(usage, tokens, bytes, state.enabledCaps, state.pricePerMillion)) {
    context.addStopReason('SCAN_CAP_REACHED');
    return false;
  }
  // Filesystem checks and token accounting are synchronous; the deadline may have
  // elapsed since the scheduler admitted this batch.
  if (!context.canStartWork()) return false;
  // Synchronous reservation before awaiting the provider: concurrent workers
  // immediately see spent and in-flight capacity.
  usage.attempts += 1;
  usage.transmittedBytes += bytes;
  usage.reservedInputTokens += tokens;
  return true;
}

/**
 * Revalidate the files a range came from, at most once each, and fill the freed
 * space from candidates already evaluated. No new provider work is ever started.
 */
function selectFresh(select: () => SelectionResult, state: {
  readonly freshness: FreshnessTracker;
  readonly snapshots: Map<string, SourceSnapshot>;
  readonly rounds: number;
  readonly context: SearchContext;
}): SelectionResult {
  const { freshness, snapshots, context } = state;
  let selection = select();
  let staleFiles = 0;
  for (let round = 0; round < state.rounds; round += 1) {
    let changed = false;
    for (const range of selection.ranges) {
      const verdict = measureSync('freshness', () => freshness.check(range.path, range.sha256));
      if (verdict.verdict !== 'fresh') {
        changed = true;
        staleFiles += 1;
        snapshots.delete(range.path);
      }
    }
    if (!changed) break;
    context.addStopReason('SOURCE_CHANGED');
    context.diagnostics.record('SOURCE_CHANGED', context.elapsedMs, { count: staleFiles });
    selection = select();
  }
  return selection;
}

/** The report's counts and usage; records PROVIDER_UNAVAILABLE when work was silently lost. */
function reportInputs(state: {
  readonly context: SearchContext;
  readonly request: { scope: string[]; max_context_tokens: number };
  readonly prepared: PreparedScope;
  readonly scored: readonly Scored[];
  readonly usage: UsageAccount;
  readonly plan: ScanPlan;
  readonly selection: SelectionResult;
  readonly freshness: FreshnessTracker;
  readonly rejected: boolean;
  readonly threshold: number;
  readonly pricePerMillion: number | null;
  /** Qualifying fragments a continuation withheld from selection because they were delivered before. */
  readonly previouslyDelivered: number;
}): ReportInputs {
  const { context, request, prepared, scored, usage, plan, selection, freshness, rejected, threshold, pricePerMillion } = state;
    const evaluated = scored.length;
    const remoteEvaluated = scored.filter((entry) => !entry.fromCache).length;
    const cacheReused = evaluated - remoteEvaluated;
    const totalFragments = prepared.complete && prepared.unreadable === 0 ? prepared.fragments.length : null;
    const notEvaluated = Math.max(0, prepared.fragments.length - evaluated);
    if (notEvaluated > 0 && !plan.capReached && !rejected && context.stop === null
      && !context.stopReasons().includes('SCAN_CAP_REACHED')) {
      context.addStopReason('PROVIDER_UNAVAILABLE');
    }

    const estimatedInputTokens = usage.knownInputTokens + usage.reservedInputTokens;
    const estimatedCostUsd = estimateInputCostUsd(estimatedInputTokens, pricePerMillion);

    return {
      searchId: context.searchId,
      scope: request.scope,
      inventoryComplete: prepared.inventory.complete && prepared.complete,
      files: {
        discovered: prepared.inventory.discovered,
        eligible: prepared.files.length,
        excludedByReason: exclusionCounts(prepared),
        unreadable: prepared.unreadable,
        changedBeforeReturn: freshness.unavailablePaths.size,
      },
      fragments: {
        total: totalFragments,
        remoteEvaluated,
        cacheReused,
        notEvaluated,
        belowThreshold: selection.belowThreshold,
        aboveThreshold: selection.aboveThreshold + state.previouslyDelivered,
        omittedStale: selection.omittedUnavailable,
      },
      threshold,
      duplicateRangesCollapsed: selection.duplicateRangesCollapsed,
      usage: {
        providerRequestAttempts: usage.attempts,
        inputTokensKnownSubtotal: usage.knownInputTokens,
        inputTokensEstimated: estimatedInputTokens,
        estimatedCostUsd,
        reportedCostUsd: null,
        attemptsWithUnknownUsage: usage.unknownUsageAttempts,
        transmittedBytes: usage.transmittedBytes,
        elapsedMs: context.elapsedMs,
      },
      preflight: totalFragments !== null ? plan.report : {
        ...plan.report,
        plannedRemoteFragments: null,
        estimatedFirstAttemptTokens: null,
        estimatedFirstAttemptCostUsd: null,
        estimatedFirstAttemptRequests: null,
        estimatedRequiredCaps: Object.fromEntries(Object.keys(plan.report.enabledCaps).map((cap) => [cap, null])),
      },
      requestedTokens: request.max_context_tokens,
      counterId: REFERENCE_COUNTER_ID,
      stopReasons: orderStopReasons(context.stopReasons()),
      diagnosticsTruncated: context.diagnostics.truncated,
      ...(rejected ? { rejected: true } : {}),
    };
}

/** Whether dispatching one more batch would pass an enabled cap, counting in-flight reservations. */
function exceedsEnabledCaps(
  usage: UsageAccount,
  tokens: number,
  bytes: number,
  enabledCaps: Partial<Record<ScanCap, number>>,
  pricePerMillion: number | null,
): boolean {
  const projectedTokens = usage.knownInputTokens + usage.reservedInputTokens + tokens;
  const projected: Partial<Record<ScanCap, number | null>> = {
    request_attempts: usage.attempts + 1,
    transmitted_bytes: usage.transmittedBytes + bytes,
    estimated_input_tokens: projectedTokens,
    estimated_cost_usd: estimateInputCostUsd(projectedTokens, pricePerMillion),
  };
  return Object.entries(projected).some(([key, value]) => {
    const cap = enabledCaps[key as ScanCap];
    return cap !== undefined && (value === null || value > cap);
  });
}

/** A score is cached only for the requested model, or a pinned revision of a rolling alias. */
function isCacheableEvaluation(
  evaluation: { readonly requestedModel: string; readonly returnedModel: string | null },
  model: string,
  adapter: string,
  cacheMode: string,
): boolean {
  if (cacheMode === 'disabled' || evaluation.requestedModel !== model) return false;
  const returned = evaluation.returnedModel;
  return returned === null || returned === model
    || (cacheMode === 'rolling' && adapter === 'typesafe-direct' && isPinnedModelRevision(returned))
    || (cacheMode === 'rolling' && adapter === 'openrouter' && isOpenRouterModelRevision(returned));
}

/** Settle one attempt's reservation against its reported usage. */
function recordUsage(
  usage: UsageAccount,
  inputTokens: number | null,
  reservedTokens: number,
  limits: {
    readonly enabledCaps: Partial<Record<ScanCap, number>>;
    readonly pricePerMillion: number | null;
    readonly context: SearchContext;
  },
): void {
  const { enabledCaps, pricePerMillion, context } = limits;
  if (inputTokens === null) {
    // The reservation survives: an attempt whose usage never resolved is still an
    // attempt the provider may have billed.
    usage.unknownUsageAttempts += 1;
    context.addStopReason('USAGE_UNKNOWN');
    return;
  }
  usage.reservedInputTokens -= reservedTokens;
  usage.knownInputTokens += inputTokens;
  const usedTokens = usage.knownInputTokens + usage.reservedInputTokens;
  const usedCost = estimateInputCostUsd(usedTokens, pricePerMillion);
  if ((enabledCaps.estimated_input_tokens !== undefined && usedTokens > enabledCaps.estimated_input_tokens)
    || (enabledCaps.estimated_cost_usd !== undefined && usedCost !== null && usedCost > enabledCaps.estimated_cost_usd)) {
    context.addStopReason('ESTIMATE_OVERRUN');
  }
}

function candidatePool(
  request: { query: string; scope: string[]; max_context_tokens: number },
  inputs: ReportInputs,
  scored: readonly Scored[],
  availableTokens: number,
  threshold: number,
  provider: { adapter: string; model: string },
): CandidatePool {
  return {
    version: CANDIDATE_POOL_VERSION, searchId: inputs.searchId, query: request.query, scope: [...request.scope],
    versions: { ...provider, criterion: CRITERION_VERSION, layout: LAYOUT_VERSION, counter: REFERENCE_COUNTER_ID },
    threshold, requestedTokens: request.max_context_tokens, availableTokens,
    candidates: scored.map(({ fragment, score }) => ({
      id: fragment.id, path: fragment.path, sha256: fragment.sha256, startLine: fragment.startLine, endLine: fragment.endLine,
      score, chunker: fragment.chunker, classification: fragment.classification, label: fragment.label ?? null,
      declaration: fragment.declaration ?? null,
    })),
    inputs,
  };
}

/** Qualifying fragments fully covered by the given ranges. */
function countRepresented(
  candidates: readonly { fragment: PreparedFragment; score: number }[],
  ranges: readonly SelectedRange[],
  threshold: number,
  unavailable: ReadonlySet<string>,
): number {
  let represented = 0;
  for (const candidate of candidates) {
    if (candidate.score < threshold || unavailable.has(candidate.fragment.path)) {
      continue;
    }
    const covered = ranges.some((range) => range.path === candidate.fragment.path
      && range.sha256 === candidate.fragment.sha256
      && range.startLine <= candidate.fragment.startLine
      && range.endLine >= candidate.fragment.endLine);
    if (covered) {
      represented += 1;
    }
  }
  return represented;
}

const STOP_REASON_ORDER = new Map<StopReason, number>();
for (const [index, reason] of [
  'SCOPE_EXCEEDS_SCAN_BUDGET', 'INVENTORY_INCOMPLETE', 'PREPARATION_LIMIT', 'SCAN_CAP_REACHED',
  'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE',
  'INVALID_PROVIDER_RESPONSE', 'USAGE_UNKNOWN', 'ESTIMATE_OVERRUN', 'SOURCE_CHANGED',
  'DEADLINE', 'CANCELLED', 'RESOURCE_EXHAUSTED',
].entries()) {
  STOP_REASON_ORDER.set(reason as StopReason, index);
}

/** Stable presentation order, so two equivalent searches report reasons identically. */
function orderStopReasons(reasons: readonly StopReason[]): StopReason[] {
  return [...new Set(reasons)].sort((left, right) => (STOP_REASON_ORDER.get(left) ?? 99) - (STOP_REASON_ORDER.get(right) ?? 99));
}

export { runEvaluations } from './evaluation/scheduler.ts';

/** Map an internal failure onto the compact contract error, or null when it is a bug. */
function errorCodeOf(cause: unknown): ErrorCode | null {
  if (cause instanceof RequestValidationError) {
    return 'INVALID_REQUEST';
  }
  if (cause instanceof ConfigurationError) {
    return cause.code;
  }
  if (cause instanceof ResponseBudgetError) {
    return 'RESPONSE_BUDGET_TOO_SMALL';
  }
  if (cause instanceof UnauthorizedPathError) {
    return 'UNAUTHORIZED_SCOPE';
  }
  if (cause instanceof ProviderError) {
    return cause.code === 'PROVIDER_RATE_LIMIT' || cause.code === 'PROVIDER_UNAVAILABLE'
      ? cause.code : cause.code === 'PROVIDER_QUOTA' ? 'PROVIDER_QUOTA' : cause.code;
  }
  if (isAbortError(cause)) {
    return 'CANCELLED';
  }
  return null;
}

/** Build an engine from a loaded configuration. */
export function createSearchEngine(options: EngineOptions): SearchEngine {
  return new SearchEngine(options);
}
