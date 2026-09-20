import type { Configuration, Diagnostics, SearchError, SearchRequest, SearchResult } from '../../src/contracts.ts';

/** Synthetic contract examples, independent of a provider, filesystem and clock. */
export const validRequest = {
  query: '  Où le cache est-il invalidé ?\r\n',
  scope: ['src', 'src/cache.ts', 'tests'],
  max_context_tokens: 4_000,
  allow_partial_scan: false,
} satisfies SearchRequest;
export const invalidRequest = { query: '  ', scope: [], max_context_tokens: 0 };

export const validConfiguration = {
  schema_version: 1,
  repository_root: 'C:/work/synthetic-repository',
  remote_evaluation_enabled: false,
  provider: {
    adapter: 'typesafe-direct', base_url: 'https://api.typesafe.ai',
    api_key_env: 'TYPESAFE_API_KEY', model: 'synthetic-model-v1',
  },
  search: { deadline_ms: 300_000, concurrency: 4, require_fit: true, default_response_tokens: 4_000, max_response_tokens: 16_000, threshold: 0.5 },
  scan_caps: {
    estimated_cost_usd: null, estimated_input_tokens: null, transmitted_bytes: null,
    request_attempts: null, prepared_source_bytes: null, candidate_files: null, fragments: null,
  },
  source: { respect_gitignore: true, follow_links: false, max_file_bytes: 1_048_576, extra_deny_globs: [] },
  cache: { enabled: true, ttl_seconds: 604_800, max_bytes: 104_857_600 },
  logging: { level: 'info', include_source: false },
} satisfies Configuration;
export const invalidConfiguration = { ...validConfiguration, source: { ...validConfiguration.source, follow_links: true } };

export const validError = {
  schema_version: '1', search_id: 'fixture-1', status: 'rejected',
  error: { code: 'INVALID_REQUEST', message: 'Check the query, relative scope paths and response budget.', retryable: false },
} satisfies SearchError;
export const invalidError = { ...validError, error: { ...validError.error, code: 'RAW_PROVIDER_FAILURE' } };

export const validDiagnostics = {
  schema_version: '1', search_id: 'fixture-1',
  events: [{ code: 'PARSE_FALLBACK', elapsed_ms: 2, count: 1 }],
  excluded_directories_by_reason: { dependency: 1 },
  observed_cap_lower_bounds: { prepared_source_bytes: 100 },
  response_tokens_measured: null,
  truncated: false,
} satisfies Diagnostics;
export const invalidDiagnostics = { ...validDiagnostics, events: [{ code: 'PARSE_FALLBACK', elapsed_ms: 2, source: 'private source' }] };

const completeResult = {
  schema_version: '1', search_id: 'fixture-1', status: 'complete',
  excerpts: [{ path: 'src/cache.ts', start_line: 2, end_line: 2, file_sha256: 'a'.repeat(64), score: 0.8, code: 'cache.clear();\r\n' }],
  report: {
    scope: ['src'], inventory_complete: true, scope_fully_scanned: true,
    files: { discovered: 1, eligible: 1, excluded_by_reason: {}, unreadable: 0, changed_before_return: 0 },
    fragments: {
      total: 2, remote_evaluated: 2, cache_reused: 0, not_evaluated: 0, below_threshold: 1, above_threshold: 1,
      represented_in_response: 1, omitted_by_response_budget: 0, omitted_stale: 0,
    },
    selection: { outcome: 'selected', threshold: 0.5, ranges_returned: 1, duplicate_ranges_collapsed: 0 },
    usage: {
      provider_request_attempts: 1, provider_input_tokens_reported: 100, provider_input_tokens_known_subtotal: 100,
      provider_input_tokens_estimated: 100, estimated_cost_usd: null, reported_cost_usd: null,
      attempts_with_unknown_usage: 0, transmitted_bytes: 256, elapsed_ms: 12,
    },
    response_budget: { requested_tokens: 4_000, counter: 'fixture-byte-counter@1', accounting: 'reference_tokenizer' },
    preflight: {
      planned_remote_fragments: 2, planned_cache_hits: 0, estimated_first_attempt_tokens: 100,
      estimated_first_attempt_cost_usd: null, estimated_first_attempt_requests: 1,
      enabled_caps: {}, estimated_required_caps: {},
    },
    stop_reasons: [], diagnostics_truncated: false,
  },
} satisfies SearchResult;

export type ResultFixture = 'complete' | 'partial' | 'rejected' | 'error' | 'deadline'
  | 'no_eligible_content' | 'no_score_above_threshold' | 'no_excerpt_fits'
  | 'no_fresh_excerpt' | 'incomplete_inventory' | 'cache_only' | 'unknown_usage';

export function resultFixture(kind: ResultFixture = 'complete'): SearchResult {
  const result: SearchResult = structuredClone(completeResult);
  const { fragments: f, usage: u, preflight: p, selection: s, files } = result.report;
  const zeroUsage = (): void => {
    Object.assign(u, { provider_request_attempts: 0, provider_input_tokens_reported: 0,
      provider_input_tokens_known_subtotal: 0, provider_input_tokens_estimated: 0, transmitted_bytes: 0 });
  };
  const noRanges = (): void => {
    result.excerpts = [];
    f.represented_in_response = 0;
    s.ranges_returned = 0;
  };
  const noScores = (): void => {
    noRanges();
    f.remote_evaluated = 0;
    f.below_threshold = 0;
    f.above_threshold = 0;
    f.not_evaluated = 2;
    s.outcome = 'no_successful_evaluation';
    result.report.scope_fully_scanned = false;
    zeroUsage();
  };
  switch (kind) {
    case 'complete': break;
    case 'partial':
      result.status = 'partial';
      result.report.scope_fully_scanned = false;
      result.report.stop_reasons = ['PROVIDER_UNAVAILABLE'];
      f.total = 3;
      f.not_evaluated = 1;
      p.planned_remote_fragments = 3;
      p.estimated_first_attempt_requests = 2;
      break;
    case 'rejected':
      noScores();
      result.status = 'rejected';
      s.outcome = 'preflight_rejected';
      result.report.stop_reasons = ['SCOPE_EXCEEDS_SCAN_BUDGET'];
      p.planned_cache_hits = 1;
      p.planned_remote_fragments = 1;
      p.enabled_caps = { request_attempts: 0 };
      p.estimated_required_caps = { request_attempts: 1 };
      break;
    case 'error':
      noScores();
      result.status = 'error';
      result.report.stop_reasons = ['PROVIDER_AUTH', 'USAGE_UNKNOWN'];
      Object.assign(u, { provider_request_attempts: 1, attempts_with_unknown_usage: 1,
        provider_input_tokens_reported: null, provider_input_tokens_estimated: 100, transmitted_bytes: 256 });
      break;
    case 'deadline':
      noScores();
      result.status = 'partial';
      result.report.stop_reasons = ['DEADLINE'];
      break;
    case 'no_eligible_content':
      noScores();
      result.report.scope_fully_scanned = true;
      files.eligible = 0;
      files.excluded_by_reason = { empty: 1 };
      f.total = 0;
      f.not_evaluated = 0;
      s.outcome = 'no_eligible_content';
      p.planned_remote_fragments = 0;
      p.estimated_first_attempt_tokens = 0;
      p.estimated_first_attempt_requests = 0;
      break;
    case 'no_score_above_threshold':
      noRanges();
      f.above_threshold = 0;
      f.below_threshold = 2;
      s.outcome = 'no_score_above_threshold';
      break;
    case 'no_excerpt_fits':
      noRanges();
      f.omitted_by_response_budget = 1;
      s.outcome = 'no_excerpt_fits';
      break;
    case 'no_fresh_excerpt':
      noRanges();
      result.status = 'partial';
      result.report.scope_fully_scanned = false;
      f.omitted_stale = 1;
      files.changed_before_return = 1;
      result.report.stop_reasons = ['SOURCE_CHANGED'];
      s.outcome = 'no_fresh_excerpt';
      break;
    case 'incomplete_inventory':
      result.status = 'partial';
      result.report.scope_fully_scanned = false;
      result.report.inventory_complete = false;
      f.total = null;
      result.report.stop_reasons = ['INVENTORY_INCOMPLETE'];
      p.planned_remote_fragments = null;
      p.estimated_first_attempt_tokens = null;
      p.estimated_first_attempt_requests = null;
      break;
    case 'cache_only':
      f.cache_reused = 2;
      f.remote_evaluated = 0;
      p.planned_remote_fragments = 0;
      p.planned_cache_hits = 2;
      p.estimated_first_attempt_tokens = 0;
      p.estimated_first_attempt_requests = 0;
      zeroUsage();
      break;
    case 'unknown_usage':
      u.provider_request_attempts = 2;
      u.attempts_with_unknown_usage = 1;
      u.provider_input_tokens_reported = null;
      u.provider_input_tokens_estimated = 180;
      result.report.stop_reasons = ['USAGE_UNKNOWN'];
      break;
  }
  return result;
}

export const RESULT_FIXTURES: readonly ResultFixture[] = [
  'complete', 'partial', 'rejected', 'error', 'deadline', 'no_eligible_content',
  'no_score_above_threshold', 'no_excerpt_fits', 'no_fresh_excerpt',
  'incomplete_inventory', 'cache_only', 'unknown_usage',
];
export const invalidResult = { ...completeResult, schema_version: '2' };
