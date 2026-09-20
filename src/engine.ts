/**
 * The shared search engine (JG-014).
 *
 * One path — question, files, fragments, cache, evaluations, selection, freshness,
 * measured response — used by the CLI and by MCP alike (requirement R10). The
 * adapters validate input and present output; they never re-implement any of this.
 *
 * Two stages are deliberately marked as seams for their owning issues, and both are
 * implemented here in their honest minimal form so the path is complete and testable:
 * `planScan` (JG-016: optional caps, reservations, rate card) and `runEvaluations`
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
import {
  CRITERION_VERSION, LAYOUT_VERSION, ProviderError, buildRequestPayload, fitsProviderLimits,
} from './evaluation/jev.ts';
import type { BatchItem, EvaluationBatch, ProviderClient } from './evaluation/jev.ts';
import { createConfiguredProvider } from './evaluation/provider.ts';
import { runEvaluations } from './evaluation/scheduler.ts';
import { SearchContext, SearchLogger, isAbortError, runPhase, systemClock } from './lifecycle.ts';
import type { Clock } from './lifecycle.ts';
import { excerptBudget, excerptCost, renderSearchResult, ResponseBudgetError } from './response/render.ts';
import type { ReportInputs, RenderedResponse } from './response/render.ts';
import { selectRanges } from './response/selection.ts';
import type { SelectedRange } from './response/selection.ts';
import { REFERENCE_COUNTER_ID, countReferenceTokens } from './response/token-counter.ts';
import { UnauthorizedPathError } from './source/authorization.ts';
import type { PreparedFragment } from './source/chunker.ts';
import { FreshnessTracker, rootReader } from './source/freshness.ts';
import { exclusionCounts, prepareScope } from './source/prepare.ts';
import type { PreparedScope } from './source/prepare.ts';
import type { SourceSnapshot } from './source/snapshot.ts';

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
  readonly clock?: Clock;
  readonly logger?: SearchLogger;
  readonly env?: NodeJS.ProcessEnv;
};

export type SearchInvocation = {
  /** Client cancellation: after it, no new result is emitted for this call. */
  readonly signal?: AbortSignal;
  readonly searchId?: string;
  /** Trusted local admission time; never taken from tool arguments. */
  readonly startedAtMs?: number;
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

/** Estimated provider input tokens for a batch; a local estimate, never a bill. */
function estimateBatchTokens(batch: EvaluationBatch, model: string, serialize?: (batch: EvaluationBatch) => string): number {
  return countReferenceTokens(serialize?.(batch) ?? JSON.stringify(buildRequestPayload(batch, model)));
}

function batchRequestBytes(batch: EvaluationBatch, model: string, serialize?: (batch: EvaluationBatch) => string): number {
  return Buffer.byteLength(serialize?.(batch) ?? JSON.stringify(buildRequestPayload(batch, model)), 'utf8');
}

/** Round up to the contract's integer nanodollar unit, including sub-unit costs. */
function estimateCost(tokens: number, pricePerMillion: number | null): number | null {
  if (pricePerMillion === null) return null;
  const rate = BigInt(Math.round(pricePerMillion * 1_000_000_000));
  return Number((BigInt(tokens) * rate + 999_999n) / 1_000_000n) / 1_000_000_000;
}

export class SearchEngine {
  readonly #options: EngineOptions;
  readonly #cache: ScoreCache;

  constructor(options: EngineOptions) {
    this.#options = options;
    const { config, cacheDirectory } = options.configuration;
    this.#cache = options.cache ?? new ScoreCache({
      directory: cacheDirectory,
      enabled: config.cache.enabled,
      ttlSeconds: config.cache.ttl_seconds,
      maxBytes: config.cache.max_bytes,
    });
  }

  get cache(): ScoreCache {
    return this.#cache;
  }

  get clock(): Clock {
    return this.#options.clock ?? systemClock;
  }

  /** Run one search. Never throws for caller input: it returns a contract outcome. */
  async search(request: unknown, invocation: SearchInvocation = {}): Promise<SearchOutcomeWithDiagnostics> {
    const { config } = this.#options.configuration;
    const context = new SearchContext({
      ...(invocation.searchId === undefined ? {} : { searchId: invocation.searchId }),
      clock: this.clock,
      ...(invocation.startedAtMs === undefined ? {} : { startedAtMs: invocation.startedAtMs }),
      deadlineMs: config.search.deadline_ms,
      ...(invocation.signal === undefined ? {} : { clientSignal: invocation.signal }),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
    });

    try {
      return await this.#run(request, context);
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

  async #run(rawRequest: unknown, context: SearchContext): Promise<SearchOutcomeWithDiagnostics> {
    const { config, sourceRoot } = this.#options.configuration;
    let request;
    try {
      request = parseSearchRequest(rawRequest, {
        default_response_tokens: config.search.default_response_tokens,
        max_response_tokens: config.search.max_response_tokens,
      });
    } catch (cause) {
      // Only a caller's request can be an invalid request; a contract failure later
      // in the pipeline is a defect and must stay loud rather than masquerade as one.
      throw cause instanceof ContractValidationError ? new RequestValidationError(cause) : cause;
    }

    // The mandatory report envelope is reserved before any work that could cost money.
    const available = excerptBudget(context.searchId, request.scope, REFERENCE_COUNTER_ID, request.max_context_tokens);

    const provider = this.#options.provider ?? createConfiguredProvider(
      config,
      resolveCredential(this.#options.configuration, this.#options.env ?? process.env),
    );

    const root = sourceRoot;
    const prepared = await runPhase(context, 'preparation', async () => prepareScope(root, request.scope, {
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
    }));

    // A lost authorization cannot become permission to send an earlier partial
    // snapshot. The anchor is retained and invalidation lasts until config reload.
    root.assertCurrent();

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

    // Cache lookup precedes planning and scheduling (specification section 6.3).
    const model = provider.model;
    const serialize = (batch: EvaluationBatch): string => provider.serializeBatch?.(batch) ?? JSON.stringify(buildRequestPayload(batch, model));
    const identityOf = (fragment: PreparedFragment, batchHash: string): string => evaluationIdentity({
      query: request.query,
      path: fragment.path,
      startLine: fragment.startLine,
      endLine: fragment.endLine,
      text: fragment.text,
      label: fragment.label ?? null,
      criterionVersion: CRITERION_VERSION,
      layoutVersion: LAYOUT_VERSION,
      chunkerVersion: fragment.chunker,
      endpoint: config.provider.base_url,
      modelRevision: model,
      providerOptions: { adapter: config.provider.adapter ?? 'typesafe-direct' },
      batchComposition: [batchHash],
    });

    const cached = new Map<string, number>();
    const pending: PreparedFragment[] = [];
    const pendingBatches: EvaluationBatch[] = [];
    const identities = new Map<string, string>();
    const fragmentsById = new Map(prepared.fragments.map((fragment) => [fragment.id, fragment]));
    // Form stable full batches before lookup. An incomplete cache hit does not
    // regroup the remaining questions and thereby change their model-visible input.
    for (const batch of buildBatches(prepared.fragments, request.query)) {
      const batchHash = createHash('sha256').update(serialize(batch)).digest('hex');
      const hits = new Map<string, number>();
      for (const item of batch.items) {
        const fragment = fragmentsById.get(item.id)!;
        const identity = identityOf(fragment, batchHash);
        identities.set(item.id, identity);
        const hit = isPinnedModelRevision(model) ? this.#cache.read(identity) : null;
        if (hit !== null) hits.set(item.id, hit);
      }
      if (hits.size === batch.items.length) {
        for (const [id, score] of hits) cached.set(id, score);
      } else {
        pendingBatches.push(batch);
        for (const item of batch.items) pending.push(fragmentsById.get(item.id)!);
      }
    }
    if (this.#cache.stats.corrupt > 0 || this.#cache.stats.failures > 0) {
      context.diagnostics.record('CACHE_UNAVAILABLE', context.elapsedMs,
        { count: this.#cache.stats.corrupt + this.#cache.stats.failures });
    }

    const enabledCaps = enabledCapsOf(config.scan_caps);
    const plan = planScan(pending, request.query, {
      model,
      batches: pendingBatches,
      serialize,
      enabledCaps,
      allowPartial: request.allow_partial_scan,
      requireFit: config.search.require_fit,
      preparedBytes: prepared.preparedBytes,
      candidateFiles: prepared.files.length,
      preparedFragments: prepared.fragments.length,
      pricePerMillionInputTokens: config.provider.pricing?.input_usd_per_million_tokens ?? null,
    });

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
      return this.#render(context, request, prepared, [], usage, plan, available, true);
    }
    if (plan.capReached) context.addStopReason('SCAN_CAP_REACHED');

    if (plan.batches.length > 0) {
      await runPhase(context, 'evaluation', async () => {
        await runEvaluations(provider, plan.batches, context, {
          concurrency: config.search.concurrency,
          ...(config.search.retry === undefined ? {} : { retry: config.search.retry }),
          onDispatch: (batch) => {
            root.assertCurrent();
            // Revalidate each named entry before disclosure, while sending only
            // the already captured snapshot bytes (never reread replacement text).
            for (const path of new Set(batch.items.map((item) => item.path))) {
              if (root.resolveEntry(path).kind !== 'file') {
                throw new UnauthorizedPathError('not_regular_file', path, 'source type changed before dispatch');
              }
            }
            const tokens = Math.max(1, estimateBatchTokens(batch, model, serialize));
            const bytes = batchRequestBytes(batch, model, serialize);
            const projected: Partial<Record<ScanCap, number | null>> = {
              request_attempts: usage.attempts + 1,
              transmitted_bytes: usage.transmittedBytes + bytes,
              estimated_input_tokens: usage.knownInputTokens + usage.reservedInputTokens + tokens,
              estimated_cost_usd: estimateCost(usage.knownInputTokens + usage.reservedInputTokens + tokens,
                config.provider.pricing?.input_usd_per_million_tokens ?? null),
            };
            if (Object.entries(projected).some(([key, value]) => {
              const cap = enabledCaps[key as ScanCap];
              return cap !== undefined && (value === null || value > cap);
            })) {
              context.addStopReason('SCAN_CAP_REACHED');
              return false;
            }
            // Filesystem checks and token accounting are synchronous; the deadline
            // may have elapsed since the scheduler admitted this batch.
            if (!context.canStartWork()) return false;
            // Synchronous reservation before awaiting the provider: concurrent
            // workers immediately see spent and in-flight capacity.
            usage.attempts += 1;
            usage.transmittedBytes += bytes;
            usage.reservedInputTokens += tokens;
            return true;
          },
          onScores: (batch, evaluation) => {
            for (const item of batch.items) {
              const score = evaluation.scores.get(item.id);
              if (score === undefined) {
                continue;
              }
              const fragment = byId.get(item.id);
              if (fragment === undefined) {
                continue;
              }
              scored.push({ fragment, score, fromCache: false });
              if (isPinnedModelRevision(model) && evaluation.requestedModel === model
                && (evaluation.returnedModel === null || evaluation.returnedModel === model)) {
                this.#cache.write(identities.get(fragment.id)!, score, {
                  modelRevision: model,
                  layout: LAYOUT_VERSION, criterion: CRITERION_VERSION, chunker: fragment.chunker,
                });
              }
            }
            if (evaluation.usage.inputTokens === null) {
              // The reservation survives: an attempt whose usage never resolved is
              // still an attempt the provider may have billed.
              usage.unknownUsageAttempts += 1;
              context.addStopReason('USAGE_UNKNOWN');
            } else {
              usage.reservedInputTokens -= Math.max(1, estimateBatchTokens(batch, model, serialize));
              usage.knownInputTokens += evaluation.usage.inputTokens;
              const usedTokens = usage.knownInputTokens + usage.reservedInputTokens;
              const usedCost = estimateCost(usedTokens, config.provider.pricing?.input_usd_per_million_tokens ?? null);
              if ((enabledCaps.estimated_input_tokens !== undefined && usedTokens > enabledCaps.estimated_input_tokens)
                || (enabledCaps.estimated_cost_usd !== undefined && usedCost !== null && usedCost > enabledCaps.estimated_cost_usd)) {
                context.addStopReason('ESTIMATE_OVERRUN');
              }
            }
            if (evaluation.invalid.length > 0) {
              context.addStopReason('INVALID_PROVIDER_RESPONSE');
              context.diagnostics.record('INVALID_PROVIDER_RESPONSE', context.elapsedMs, { count: evaluation.invalid.length });
            }
          },
          onFailure: (batch, failure, willRetry) => {
            usage.unknownUsageAttempts += 1;
            context.addStopReason('USAGE_UNKNOWN');
            if (!willRetry && (!failure.cancelled || context.stop === null)) context.addStopReason(failure.code);
            context.diagnostics.record(failure.code, context.elapsedMs, { count: batch.items.length });
          },
        });
      });
    }

    return this.#render(context, request, prepared, scored, usage, plan, available, false);
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
  ): SearchOutcomeWithDiagnostics {
    const { config } = this.#options.configuration;
    const snapshots = new Map<string, SourceSnapshot>();
    for (const file of prepared.files) {
      snapshots.set(file.snapshot.relativePath, file.snapshot);
    }
    const freshness = new FreshnessTracker(rootReader(
      this.#options.configuration.sourceRoot, config.source.max_file_bytes,
    ));

    const candidates = scored.map(({ fragment, score }) => ({ fragment, score }));
    const sliceLines = (path: string, startLine: number, endLine: number): string | null => {
      const snapshot = snapshots.get(path);
      return snapshot === undefined ? null : snapshot.sliceLines(startLine, endLine).text;
    };

    let selection = selectRanges(candidates, {
      threshold: config.search.threshold,
      availableTokens,
      measure: excerptCost,
      sliceLines,
      unavailablePaths: freshness.unavailablePaths,
    });

    // Revalidate the files a range came from, at most once each, and fill the freed
    // space from candidates already evaluated. No new provider work is ever started.
    let staleFiles = 0;
    for (let round = 0; round < prepared.files.length + 1; round += 1) {
      let changed = false;
      for (const range of selection.ranges) {
        const verdict = freshness.check(range.path, range.sha256);
        if (verdict.verdict !== 'fresh') {
          changed = true;
          staleFiles += 1;
          snapshots.delete(range.path);
        }
      }
      if (!changed) {
        break;
      }
      context.addStopReason('SOURCE_CHANGED');
      context.diagnostics.record('SOURCE_CHANGED', context.elapsedMs, { count: staleFiles });
      selection = selectRanges(candidates, {
        threshold: config.search.threshold,
        availableTokens,
        measure: excerptCost,
        sliceLines,
        unavailablePaths: freshness.unavailablePaths,
      });
    }

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
    const pricing = config.provider.pricing;
    const estimatedCostUsd = estimateCost(estimatedInputTokens, pricing?.input_usd_per_million_tokens ?? null);

    const inputs: ReportInputs = {
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
        aboveThreshold: selection.aboveThreshold,
        omittedStale: selection.omittedUnavailable,
      },
      threshold: config.search.threshold,
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

    const representedFor = (ranges: readonly SelectedRange[]): number => countRepresented(candidates, ranges, config.search.threshold, freshness.unavailablePaths);
    const rendered: RenderedResponse = renderSearchResult(inputs, rejected ? [] : selection.ranges, representedFor);
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

function enabledCapsOf(caps: Readonly<Record<ScanCap, number | null>>): Partial<Record<ScanCap, number>> {
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
  const batches = options.batches ?? buildBatches(fragments, query);
  const estimatedTokens = batches.reduce((sum, batch) => sum + estimateBatchTokens(batch, options.model, options.serialize), 0);
  const estimatedBytes = batches.reduce((sum, batch) => sum + batchRequestBytes(batch, options.model, options.serialize), 0);
  const estimatedCost = estimateCost(estimatedTokens, options.pricePerMillionInputTokens);
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
    const nextTokens = tokens + estimateBatchTokens(batch, options.model, options.serialize);
    const nextBytes = bytes + batchRequestBytes(batch, options.model, options.serialize);
    const needs: Partial<Record<ScanCap, number | null>> = {
      estimated_input_tokens: nextTokens,
      transmitted_bytes: nextBytes,
      request_attempts: admitted.length + 1,
      estimated_cost_usd: estimateCost(nextTokens, options.pricePerMillionInputTokens),
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
export function buildBatches(fragments: readonly PreparedFragment[], query: string, maxItems = 8): EvaluationBatch[] {
  const ordered = [...fragments].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    || (left.startLine - right.startLine) || (left.endLine - right.endLine));
  const batches: EvaluationBatch[] = [];
  let items: BatchItem[] = [];

  const flush = (): void => {
    if (items.length > 0) {
      batches.push({ query, items });
      items = [];
    }
  };

  for (const fragment of ordered) {
    const item: BatchItem = {
      id: fragment.id, path: fragment.path,
      startLine: fragment.startLine, endLine: fragment.endLine,
      text: fragment.text, label: fragment.label ?? null,
    };
    const candidate = { query, items: [...items, item] };
    if (!fitsProviderLimits({ query, items: [item] }, 'estimate')) {
      throw new ConfigurationError('INVALID_REQUEST', 'one question exceeds the provider context estimate');
    }
    if (items.length >= maxItems || (items.length > 0 && !fitsProviderLimits(candidate, 'estimate'))) {
      flush();
    }
    items.push(item);
  }
  flush();
  return batches;
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
