/**
 * Report assembly and the measured response budget.
 *
 * JG-020 owns the final guarantee of specification section 8.2; this module provides
 * the measured rendering the first end-to-end path (JG-014) needs, with the same
 * rules, so that the engine never grows a second, weaker accounting:
 *
 * - a conservative envelope for the mandatory report is reserved *before* any paid
 *   work, and a budget that cannot hold it is refused with `RESPONSE_BUDGET_TOO_SMALL`;
 * - the complete serialized payload is measured with the pinned counter, including
 *   paths, hashes, scores, JSON escaping, counters and the report;
 * - ranges are removed, lowest priority first, until the payload fits, and the
 *   omission counters are recomputed after every removal;
 * - nothing is ever truncated: no cut JSON string, no cut source line, no cut range;
 * - the measured token count stays in local diagnostics, never inside the payload it
 *   would have to describe.
 */
import {
  CONTRACT_LIMITS, EXCLUSION_REASONS, SCAN_CAP_KEYS, SCHEMA_VERSION, STOP_REASONS, searchResultSchema,
} from '../contracts.ts';
import type { ScanCap, SearchResult, StopReason } from '../contracts.ts';
import type { SelectedRange } from './selection.ts';
import { countReferenceTokens } from './token-counter.ts';

export type ReportUsage = {
  readonly providerRequestAttempts: number;
  readonly inputTokensKnownSubtotal: number;
  readonly inputTokensEstimated: number;
  readonly estimatedCostUsd: number | null;
  readonly reportedCostUsd: number | null;
  readonly attemptsWithUnknownUsage: number;
  readonly transmittedBytes: number;
  readonly elapsedMs: number;
};

export type ReportPreflight = {
  readonly plannedRemoteFragments: number | null;
  readonly plannedCacheHits: number;
  readonly estimatedFirstAttemptTokens: number | null;
  readonly estimatedFirstAttemptCostUsd: number | null;
  readonly estimatedFirstAttemptRequests: number | null;
  readonly enabledCaps: Readonly<Partial<Record<ScanCap, number>>>;
  readonly estimatedRequiredCaps: Readonly<Partial<Record<ScanCap, number | null>>>;
};

export type ReportInputs = {
  readonly searchId: string;
  readonly scope: readonly string[];
  readonly inventoryComplete: boolean;
  readonly files: {
    readonly discovered: number;
    readonly eligible: number;
    readonly excludedByReason: Readonly<Record<string, number>>;
    readonly unreadable: number;
    readonly changedBeforeReturn: number;
  };
  readonly fragments: {
    /** null whenever preparation could not finish; never a partial count presented as a total. */
    readonly total: number | null;
    readonly remoteEvaluated: number;
    readonly cacheReused: number;
    readonly notEvaluated: number;
    readonly belowThreshold: number;
    readonly aboveThreshold: number;
    readonly omittedStale: number;
  };
  readonly threshold: number;
  readonly duplicateRangesCollapsed: number;
  readonly usage: ReportUsage;
  readonly preflight: ReportPreflight;
  readonly requestedTokens: number;
  readonly counterId: string;
  readonly stopReasons: readonly StopReason[];
  readonly diagnosticsTruncated: boolean;
  /** True when the search was rejected before dispatch by an enabled scan cap. */
  readonly rejected?: boolean;
};

export class ResponseBudgetError extends Error {
  override readonly name = 'ResponseBudgetError';
  readonly code = 'RESPONSE_BUDGET_TOO_SMALL';
  readonly requiredTokens: number;
  readonly requestedTokens: number;

  constructor(requiredTokens: number, requestedTokens: number) {
    super(`the mandatory report needs ${String(requiredTokens)} reference tokens but the budget is ${String(requestedTokens)}`);
    this.requiredTokens = requiredTokens;
    this.requestedTokens = requestedTokens;
  }
}

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Conservative upper bound for the report that must be present in every response.
 *
 * It reserves the widest supported numbers, every documented stop reason, every
 * exclusion key and every cap key, plus the caller's real scope strings and search
 * id. Reserving only today's smallest report would let a later, larger report break
 * the guarantee.
 */
export function mandatoryEnvelopeTokens(searchId: string, scope: readonly string[], counterId: string): number {
  const worstCaseCaps = Object.fromEntries(SCAN_CAP_KEYS.map((key) => [key, MAX_COUNT]));
  const envelope = {
    schema_version: SCHEMA_VERSION,
    search_id: searchId,
    status: 'partial',
    excerpts: [],
    report: {
      scope: [...scope],
      inventory_complete: false,
      scope_fully_scanned: false,
      files: {
        discovered: MAX_COUNT, eligible: MAX_COUNT,
        excluded_by_reason: Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, MAX_COUNT])),
        unreadable: MAX_COUNT, changed_before_return: MAX_COUNT,
      },
      fragments: {
        total: MAX_COUNT, remote_evaluated: MAX_COUNT, cache_reused: MAX_COUNT, not_evaluated: MAX_COUNT,
        below_threshold: MAX_COUNT, above_threshold: MAX_COUNT, represented_in_response: MAX_COUNT,
        omitted_by_response_budget: MAX_COUNT, omitted_stale: MAX_COUNT,
      },
      selection: {
        outcome: 'no_successful_evaluation', threshold: 0.123456789,
        ranges_returned: MAX_COUNT, duplicate_ranges_collapsed: MAX_COUNT,
      },
      usage: {
        provider_request_attempts: MAX_COUNT, provider_input_tokens_reported: MAX_COUNT,
        provider_input_tokens_known_subtotal: MAX_COUNT, provider_input_tokens_estimated: MAX_COUNT,
        estimated_cost_usd: 1234.567891, reported_cost_usd: 1234.567891,
        attempts_with_unknown_usage: MAX_COUNT, transmitted_bytes: MAX_COUNT, elapsed_ms: MAX_COUNT,
      },
      response_budget: { requested_tokens: MAX_COUNT, counter: counterId, accounting: 'reference_tokenizer' },
      preflight: {
        planned_remote_fragments: MAX_COUNT, planned_cache_hits: MAX_COUNT,
        estimated_first_attempt_tokens: MAX_COUNT, estimated_first_attempt_cost_usd: 1234.567891,
        estimated_first_attempt_requests: MAX_COUNT,
        enabled_caps: worstCaseCaps, estimated_required_caps: worstCaseCaps,
      },
      stop_reasons: [...STOP_REASONS],
      diagnostics_truncated: false,
    },
  };
  return countReferenceTokens(JSON.stringify(envelope));
}

/** Tokens available for excerpts under a requested budget, or a refusal before any cost. */
export function excerptBudget(searchId: string, scope: readonly string[], counterId: string, requestedTokens: number): number {
  const envelope = mandatoryEnvelopeTokens(searchId, scope, counterId);
  if (envelope >= requestedTokens) {
    throw new ResponseBudgetError(envelope, requestedTokens);
  }
  return requestedTokens - envelope;
}

/** Serialized cost of one excerpt, measured exactly as it will appear in the payload. */
export function excerptCost(range: SelectedRange): number {
  return countReferenceTokens(JSON.stringify({
    path: range.path,
    start_line: range.startLine,
    end_line: range.endLine,
    file_sha256: range.sha256,
    score: range.score,
    code: range.text,
  }) + ',');
}

type Excerpt = SearchResult['excerpts'][number];

function toExcerpt(range: SelectedRange): Excerpt {
  return {
    path: range.path,
    start_line: range.startLine,
    end_line: range.endLine,
    file_sha256: range.sha256,
    score: range.score,
    code: range.text,
  };
}

/** Empty-selection precedence of specification section 4.2. */
function selectionOutcome(inputs: ReportInputs, excerptCount: number, omittedStale: number): SearchResult['report']['selection']['outcome'] {
  if (inputs.rejected === true) {
    return 'preflight_rejected';
  }
  if (excerptCount > 0) {
    return 'selected';
  }
  const evaluated = inputs.fragments.remoteEvaluated + inputs.fragments.cacheReused;
  if (inputs.inventoryComplete && inputs.fragments.total === 0) {
    return 'no_eligible_content';
  }
  if (evaluated === 0) {
    return 'no_successful_evaluation';
  }
  if (inputs.fragments.aboveThreshold === 0) {
    return 'no_score_above_threshold';
  }
  if (omittedStale > 0 && omittedStale === inputs.fragments.aboveThreshold) {
    return 'no_fresh_excerpt';
  }
  return 'no_excerpt_fits';
}

function assembleResult(inputs: ReportInputs, ranges: readonly SelectedRange[], representedFragments: number): SearchResult {
  const excerpts = ranges.map(toExcerpt);
  const evaluated = inputs.fragments.remoteEvaluated + inputs.fragments.cacheReused;
  const omittedStale = inputs.fragments.omittedStale;
  const omittedByBudget = inputs.fragments.aboveThreshold - representedFragments - omittedStale;
  const fullyScanned = inputs.rejected !== true
    && inputs.inventoryComplete
    && inputs.fragments.total !== null
    && inputs.fragments.notEvaluated === 0
    && inputs.files.unreadable === 0
    && inputs.files.changedBeforeReturn === 0
    && inputs.stopReasons.every((reason) => reason === 'USAGE_UNKNOWN' || reason === 'ESTIMATE_OVERRUN');
  const status: SearchResult['status'] = inputs.rejected === true ? 'rejected'
    : fullyScanned ? 'complete'
      : evaluated === 0 && inputs.stopReasons.some((reason) => reason === 'PROVIDER_AUTH' || reason === 'PROVIDER_QUOTA'
        || reason === 'PROVIDER_UNAVAILABLE' || reason === 'INVALID_PROVIDER_RESPONSE' || reason === 'PROVIDER_RATE_LIMIT'
        || reason === 'RESOURCE_EXHAUSTED' || reason === 'CANCELLED') ? 'error' : 'partial';

  return {
    schema_version: SCHEMA_VERSION,
    search_id: inputs.searchId,
    status,
    excerpts,
    report: {
      scope: [...inputs.scope],
      inventory_complete: inputs.inventoryComplete,
      scope_fully_scanned: fullyScanned,
      files: {
        discovered: inputs.files.discovered,
        eligible: inputs.files.eligible,
        excluded_by_reason: { ...inputs.files.excludedByReason },
        unreadable: inputs.files.unreadable,
        changed_before_return: inputs.files.changedBeforeReturn,
      },
      fragments: {
        total: inputs.fragments.total,
        remote_evaluated: inputs.fragments.remoteEvaluated,
        cache_reused: inputs.fragments.cacheReused,
        not_evaluated: inputs.fragments.notEvaluated,
        below_threshold: inputs.fragments.belowThreshold,
        above_threshold: inputs.fragments.aboveThreshold,
        represented_in_response: representedFragments,
        omitted_by_response_budget: Math.max(0, omittedByBudget),
        omitted_stale: omittedStale,
      },
      selection: {
        outcome: selectionOutcome(inputs, excerpts.length, omittedStale),
        threshold: inputs.threshold,
        ranges_returned: excerpts.length,
        duplicate_ranges_collapsed: inputs.duplicateRangesCollapsed,
      },
      usage: {
        provider_request_attempts: inputs.usage.providerRequestAttempts,
        provider_input_tokens_reported: inputs.usage.attemptsWithUnknownUsage === 0
          ? inputs.usage.inputTokensKnownSubtotal : null,
        provider_input_tokens_known_subtotal: inputs.usage.inputTokensKnownSubtotal,
        provider_input_tokens_estimated: inputs.usage.inputTokensEstimated,
        estimated_cost_usd: inputs.usage.estimatedCostUsd,
        reported_cost_usd: inputs.usage.reportedCostUsd,
        attempts_with_unknown_usage: inputs.usage.attemptsWithUnknownUsage,
        transmitted_bytes: inputs.usage.transmittedBytes,
        elapsed_ms: inputs.usage.elapsedMs,
      },
      response_budget: {
        requested_tokens: inputs.requestedTokens,
        counter: inputs.counterId,
        accounting: 'reference_tokenizer',
      },
      preflight: {
        planned_remote_fragments: inputs.preflight.plannedRemoteFragments,
        planned_cache_hits: inputs.preflight.plannedCacheHits,
        estimated_first_attempt_tokens: inputs.preflight.estimatedFirstAttemptTokens,
        estimated_first_attempt_cost_usd: inputs.preflight.estimatedFirstAttemptCostUsd,
        estimated_first_attempt_requests: inputs.preflight.estimatedFirstAttemptRequests,
        enabled_caps: { ...inputs.preflight.enabledCaps },
        estimated_required_caps: { ...inputs.preflight.estimatedRequiredCaps },
      },
      stop_reasons: [...inputs.stopReasons],
      diagnostics_truncated: inputs.diagnosticsTruncated,
    },
  } as SearchResult;
}

export type RenderedResponse = {
  readonly result: SearchResult;
  readonly text: string;
  /** Local diagnostic only; putting it in the payload would make the count self-referential. */
  readonly measuredTokens: number;
  readonly removedForBudget: number;
};

/**
 * Render a validated response that fits its declared budget.
 *
 * `representedFor` recomputes how many qualifying fragments a given set of ranges
 * represents, so the counters stay true after each removal.
 */
export function renderSearchResult(
  inputs: ReportInputs,
  ranges: readonly SelectedRange[],
  representedFor: (ranges: readonly SelectedRange[]) => number,
): RenderedResponse {
  let current = [...ranges];
  let removed = 0;

  for (;;) {
    const result = assembleResult(inputs, current, representedFor(current));
    const validated = searchResultSchema.parse(result);
    const text = JSON.stringify(validated);
    const measured = countReferenceTokens(text);
    if (measured <= inputs.requestedTokens || current.length === 0) {
      if (measured > inputs.requestedTokens) {
        // Nothing left to remove: the mandatory report alone exceeds the budget, which
        // the preflight envelope is meant to have refused before any paid work.
        throw new ResponseBudgetError(measured, inputs.requestedTokens);
      }
      return { result: validated, text, measuredTokens: measured, removedForBudget: removed };
    }
    // Remove the lowest-priority range: lowest score, then the latest path and line.
    let victim = 0;
    for (let index = 1; index < current.length; index += 1) {
      const candidate = current[index];
      const worst = current[victim];
      if (candidate === undefined || worst === undefined) {
        continue;
      }
      if (candidate.score < worst.score
        || (candidate.score === worst.score && candidate.path > worst.path)
        || (candidate.score === worst.score && candidate.path === worst.path && candidate.startLine > worst.startLine)) {
        victim = index;
      }
    }
    current = current.filter((_, index) => index !== victim);
    removed += 1;
  }
}

/** Compact error payload bounds from specification section 4.4. */
export function errorFitsBounds(serialized: string): boolean {
  return Buffer.byteLength(serialized, 'utf8') <= CONTRACT_LIMITS.error_bytes
    && countReferenceTokens(serialized) <= CONTRACT_LIMITS.error_tokens;
}
