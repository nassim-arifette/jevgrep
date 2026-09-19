import {
  array, booleanValue, codeMap, enumeration, literal, nullable, numberValue,
  object, refine, requireContract, schema, textValue,
} from './contract-schema.ts';
import type { Infer } from './contract-schema.ts';
export { ContractValidationError } from './contract-schema.ts';

export const SCHEMA_VERSION = '1';
export const CONFIG_SCHEMA_VERSION = 1;
export const CONTRACT_LIMITS = Object.freeze({
  query_bytes: 8_192,
  scope_entries: 32,
  scope_bytes: 4_096,
  min_response_tokens: 1_024,
  default_response_tokens: 4_000,
  max_response_tokens: 16_000,
  error_bytes: 4_096,
  error_tokens: 1_024,
  diagnostic_events: 64,
});

export const SCAN_CAP_KEYS = [
  'estimated_cost_usd', 'estimated_input_tokens', 'transmitted_bytes',
  'request_attempts', 'prepared_source_bytes', 'candidate_files', 'fragments',
] as const;
export type ScanCap = typeof SCAN_CAP_KEYS[number];

export const EXCLUSION_REASONS = [
  'administrative', 'credential_file', 'operator_denied', 'gitignored',
  'jevgrepignored', 'dependency', 'build_output', 'generated', 'minified',
  'unsupported_encoding', 'binary', 'file_too_large', 'credential_pattern',
  'empty', 'whitespace_only', 'unsupported_format', 'unsupported_long_line',
  'link', 'outside_root', 'not_regular_file',
] as const;

export const STOP_REASONS = [
  'INVALID_REQUEST', 'INVALID_CONFIG', 'UNAUTHORIZED_SCOPE', 'REMOTE_DISABLED',
  'CREDENTIAL_MISSING', 'BUSY', 'SCOPE_EXCEEDS_SCAN_BUDGET',
  'RESPONSE_BUDGET_TOO_SMALL', 'INVENTORY_INCOMPLETE', 'PREPARATION_LIMIT',
  'PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE',
  'INVALID_PROVIDER_RESPONSE', 'USAGE_UNKNOWN', 'SCAN_CAP_REACHED',
  'ESTIMATE_OVERRUN', 'DEADLINE', 'CANCELLED', 'SOURCE_CHANGED', 'RESOURCE_EXHAUSTED',
] as const;
export type StopReason = typeof STOP_REASONS[number];

// Status, retry advice and bounded recovery text are owned here, never by a provider.
export const ERROR_DEFINITIONS = {
  INVALID_REQUEST: ['rejected', false, 'Check the query, relative scope paths and response budget.'],
  INVALID_CONFIG: ['rejected', false, 'Correct the trusted configuration before searching.'],
  UNAUTHORIZED_SCOPE: ['rejected', false, 'Choose an authorized relative scope without linked paths.'],
  REMOTE_DISABLED: ['rejected', false, 'Enable remote evaluation in the trusted operator configuration.'],
  CREDENTIAL_MISSING: ['rejected', false, 'Set the configured credential environment variable.'],
  BUSY: ['rejected', true, 'Wait for the active search and pending search to finish.'],
  SCOPE_EXCEEDS_SCAN_BUDGET: ['rejected', false, 'Narrow the scope or explicitly allow a partial scan.'],
  RESPONSE_BUDGET_TOO_SMALL: ['rejected', false, 'Increase the response budget or narrow the scope.'],
  PROVIDER_AUTH: ['error', false, 'Check the provider credential and access to the configured model.'],
  PROVIDER_QUOTA: ['error', false, 'Check the provider account quota before searching again.'],
  PROVIDER_RATE_LIMIT: ['error', true, 'Wait before retrying the search within the configured limits.'],
  PROVIDER_UNAVAILABLE: ['error', true, 'Check provider availability; a dispatched attempt may have incurred usage.'],
  INVALID_PROVIDER_RESPONSE: ['error', false, 'Check compatibility with the configured provider model and adapter.'],
  RESOURCE_EXHAUSTED: ['error', false, 'Free local resources or narrow the search scope.'],
  CANCELLED: ['error', false, 'The search was interrupted; dispatched attempts may have incurred usage.'],
} as const;
export type ErrorCode = keyof typeof ERROR_DEFINITIONS;
export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as ErrorCode[];

const count = numberValue(0, Number.MAX_SAFE_INTEGER);
const positiveCount = numberValue(1, Number.MAX_SAFE_INTEGER);
const probability = numberValue(0, 1, false);
// Public USD values are decimals; accounting converts to integer nanodollars.
const usd = refine(numberValue(0, Number.MAX_SAFE_INTEGER / 1_000_000_000, false), (value, path) => {
  const units = value * 1_000_000_000;
  const rounded = Math.round(units);
  requireContract((value === 0 || value >= 1e-9) && Number.isSafeInteger(rounded)
    && Math.abs(units - rounded) <= Number.EPSILON * Math.max(1, units) * 2,
  path, 'USD amounts must be representable as integer nanodollars');
});
const identifier = refine(textValue(128), (value, path) => {
  requireContract(/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(value), path, 'expected a bounded identifier');
});
const version = literal(SCHEMA_VERSION);
const responseTokens = numberValue(CONTRACT_LIMITS.min_response_tokens, Number.MAX_SAFE_INTEGER);

function normalizedPath(input: string, path: string): string {
  requireContract(!/^[\\/]/.test(input), path, 'absolute and namespace paths are forbidden');
  requireContract(!/[\u0000-\u001f\u007f<>:"|?*]/.test(input), path, 'unsupported path syntax');
  const segments = input.replaceAll('\\', '/').split('/');
  requireContract(!segments.includes('..'), path, 'parent traversal is forbidden');
  const parts = segments.filter((part) => part !== '' && part !== '.');
  for (const part of parts) {
    requireContract(!/[. ]$/.test(part), path, 'ambiguous trailing path characters');
    requireContract(!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), path, 'device names are forbidden');
  }
  return parts.join('/') || '.';
}

const scopePath = refine(textValue(CONTRACT_LIMITS.scope_bytes), (value, path) => {
  normalizedPath(value, path);
});
const scopeSchema = refine(array(scopePath, 1, CONTRACT_LIMITS.scope_entries), (value, path) => {
  requireContract(value.reduce((sum, item) => sum + Buffer.byteLength(item), 0) <= CONTRACT_LIMITS.scope_bytes,
    path, 'combined scope UTF-8 byte limit exceeded');
});

function normalizeScope(scope: readonly string[]): string[] {
  const paths = [...new Set(scope.map((value) => normalizedPath(value, '$.scope')))];
  return paths.filter((value) => !paths.some((parent) =>
    parent !== value && (parent === '.' || value.startsWith(`${parent}/`)),
  )).sort();
}

const canonicalScope = refine(scopeSchema, (value, path) => {
  requireContract(JSON.stringify(value) === JSON.stringify(normalizeScope(value)), path, 'expected canonical, deduplicated scope');
});
const excerptPath = refine(scopePath, (value, path) => {
  requireContract(value !== '.' && normalizedPath(value, path) === value, path, 'expected a canonical relative file path');
});

export type ResponseLimits = { default_response_tokens: number; max_response_tokens: number };
const defaultResponseLimits: ResponseLimits = {
  default_response_tokens: CONTRACT_LIMITS.default_response_tokens,
  max_response_tokens: CONTRACT_LIMITS.max_response_tokens,
};

export function createSearchRequestSchema(limits: ResponseLimits = defaultResponseLimits) {
  responseTokens.parse(limits.max_response_tokens, '$.max_response_tokens');
  responseTokens.parse(limits.default_response_tokens, '$.default_response_tokens');
  requireContract(limits.default_response_tokens <= limits.max_response_tokens, '$.default_response_tokens', 'default exceeds maximum');
  return object({ query: textValue(CONTRACT_LIMITS.query_bytes) }, {
    scope: scopeSchema,
    max_context_tokens: numberValue(CONTRACT_LIMITS.min_response_tokens, limits.max_response_tokens),
    allow_partial_scan: booleanValue,
  });
}
export const searchRequestSchema = createSearchRequestSchema();
export type SearchRequest = Infer<typeof searchRequestSchema>;
export type ResolvedSearchRequest = Required<SearchRequest>;

/** Pure lexical validation. Filesystem authorization remains the source reader's job. */
export function parseSearchRequest(input: unknown, limits: ResponseLimits = defaultResponseLimits): ResolvedSearchRequest {
  const request = createSearchRequestSchema(limits).parse(input);
  return {
    query: request.query,
    scope: normalizeScope(request.scope ?? ['.']),
    max_context_tokens: request.max_context_tokens ?? limits.default_response_tokens,
    allow_partial_scan: request.allow_partial_scan ?? false,
  };
}

const capValues = {
  estimated_cost_usd: nullable(usd),
  estimated_input_tokens: nullable(count),
  transmitted_bytes: nullable(count),
  request_attempts: nullable(count),
  prepared_source_bytes: nullable(count),
  candidate_files: nullable(count),
  fragments: nullable(count),
};
export const scanCapsSchema = object(capValues);
const enabledCapsSchema = object({}, {
  estimated_cost_usd: usd, estimated_input_tokens: count, transmitted_bytes: count,
  request_attempts: count, prepared_source_bytes: count, candidate_files: count, fragments: count,
});
const requiredCapsSchema = object({}, capValues);

const pricingSchema = object({
  model: identifier,
  verified_at: refine(textValue(10), (value, path) => {
    const timestamp = Date.parse(value);
    requireContract(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp)
      && new Date(timestamp).toISOString().slice(0, 10) === value, path, 'expected a valid YYYY-MM-DD pricing date');
  }),
  input_usd_per_million_tokens: usd,
  output_usd_per_million_tokens: usd,
});

export const configurationSchema = refine(object({
  schema_version: literal(CONFIG_SCHEMA_VERSION),
  repository_root: refine(textValue(4_096), (value, path) => {
    requireContract(!/[\u0000-\u001f\u007f]/.test(value), path, 'control characters are forbidden');
    requireContract((value.startsWith('/') && !value.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(value),
      path, 'expected an absolute POSIX or Windows drive path');
    requireContract(!value.replaceAll('\\', '/').split('/').includes('..'), path, 'parent traversal is forbidden');
  }),
  remote_evaluation_enabled: booleanValue,
  provider: object({
    base_url: refine(textValue(256), (value, path) => {
      requireContract(/^https:\/\/(?:api\.typesafe\.ai|ai-gateway\.vercel\.sh)\/?$/.test(value), path,
        'unsupported provider endpoint');
    }),
    api_key_env: refine(textValue(128), (value, path) => {
      requireContract(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value), path, 'expected an environment variable name');
    }),
    model: identifier,
  }, {
    adapter: enumeration(['typesafe-direct', 'vercel-ai-gateway']),
    pricing: nullable(pricingSchema),
  }),
  search: object({
    deadline_ms: positiveCount,
    concurrency: positiveCount,
    require_fit: literal(true),
    default_response_tokens: responseTokens,
    max_response_tokens: responseTokens,
    threshold: probability,
  }),
  scan_caps: scanCapsSchema,
  source: object({
    respect_gitignore: booleanValue,
    follow_links: literal(false),
    max_file_bytes: positiveCount,
    extra_deny_globs: array(textValue(4_096), 0, 128),
  }),
  cache: object({ enabled: booleanValue, ttl_seconds: positiveCount, max_bytes: positiveCount }),
  logging: object({ level: enumeration(['silent', 'error', 'warn', 'info', 'debug']), include_source: literal(false) }),
}), (value, path) => {
  requireContract(value.search.default_response_tokens <= value.search.max_response_tokens,
    `${path}.search`, 'default response budget exceeds maximum');
  const pricing = value.provider.pricing;
  requireContract(pricing == null || pricing.model === value.provider.model, `${path}.provider.pricing`, 'pricing must match the configured model');
  requireContract(value.scan_caps.estimated_cost_usd === null || pricing != null,
    `${path}.scan_caps.estimated_cost_usd`, 'a USD cap requires a dated pricing record for the model');
  const adapter = value.provider.adapter ?? 'typesafe-direct';
  if (adapter === 'typesafe-direct') {
    requireContract(/^https:\/\/api\.typesafe\.ai\/?$/.test(value.provider.base_url), `${path}.provider.base_url`,
      'typesafe-direct requires https://api.typesafe.ai');
  } else {
    requireContract(/^https:\/\/ai-gateway\.vercel\.sh\/?$/.test(value.provider.base_url), `${path}.provider.base_url`,
      'vercel-ai-gateway requires https://ai-gateway.vercel.sh');
    requireContract(value.provider.model === 'typesafe-ai/jev', `${path}.provider.model`,
      'vercel-ai-gateway requires the typesafe-ai/jev model id');
  }
});
export type Configuration = Infer<typeof configurationSchema>;

/** No model availability or pricing is inferred; the operator supplies the model. */
export function createDefaultConfiguration(repositoryRoot: string, model: string): Configuration {
  return configurationSchema.parse({
    schema_version: CONFIG_SCHEMA_VERSION,
    repository_root: repositoryRoot,
    remote_evaluation_enabled: false,
    provider: {
      adapter: 'typesafe-direct', base_url: 'https://api.typesafe.ai',
      api_key_env: 'TYPESAFE_API_KEY', model,
    },
    search: { deadline_ms: 60_000, concurrency: 4, require_fit: true, ...defaultResponseLimits, threshold: 0.5 },
    scan_caps: Object.fromEntries(SCAN_CAP_KEYS.map((key) => [key, null])),
    source: { respect_gitignore: true, follow_links: false, max_file_bytes: 1_048_576, extra_deny_globs: [] },
    cache: { enabled: true, ttl_seconds: 604_800, max_bytes: 104_857_600 },
    logging: { level: 'info', include_source: false },
  });
}

const excerptSchema = refine(object({
  path: excerptPath,
  start_line: positiveCount,
  end_line: positiveCount,
  file_sha256: refine(textValue(64), (value, path) => {
    requireContract(/^[a-f0-9]{64}$/.test(value), path, 'expected a lowercase SHA-256 hex digest');
  }),
  score: probability,
  code: refine(textValue(Number.MAX_SAFE_INTEGER, false), (value, path) => {
    requireContract(value.length > 0, path, 'an excerpt must contain source text');
  }),
}), (value, path) => {
  requireContract(value.start_line <= value.end_line, path, 'inverted inclusive line range');
});

const resultShape = object({
  schema_version: version,
  search_id: identifier,
  status: enumeration(['complete', 'partial', 'rejected', 'error']),
  excerpts: array(excerptSchema),
  report: object({
    scope: canonicalScope,
    inventory_complete: booleanValue,
    scope_fully_scanned: booleanValue,
    files: object({
      discovered: count, eligible: count, excluded_by_reason: codeMap(EXCLUSION_REASONS, count),
      unreadable: count, changed_before_return: count,
    }),
    fragments: object({
      total: nullable(count), remote_evaluated: count, cache_reused: count, not_evaluated: count,
      below_threshold: count, above_threshold: count, represented_in_response: count,
      omitted_by_response_budget: count, omitted_stale: count,
    }),
    selection: object({
      outcome: enumeration(['selected', 'no_eligible_content', 'no_score_above_threshold',
        'no_excerpt_fits', 'no_successful_evaluation', 'no_fresh_excerpt', 'preflight_rejected']),
      threshold: probability, ranges_returned: count, duplicate_ranges_collapsed: count,
    }),
    usage: object({
      provider_request_attempts: count, provider_input_tokens_reported: nullable(count),
      provider_input_tokens_known_subtotal: count, provider_input_tokens_estimated: count,
      estimated_cost_usd: nullable(usd), reported_cost_usd: nullable(usd),
      attempts_with_unknown_usage: count, transmitted_bytes: count, elapsed_ms: count,
    }),
    response_budget: object({ requested_tokens: responseTokens, counter: identifier, accounting: literal('reference_tokenizer') }),
    preflight: object({
      planned_remote_fragments: nullable(count), planned_cache_hits: count,
      estimated_first_attempt_tokens: nullable(count), estimated_first_attempt_cost_usd: nullable(usd),
      estimated_first_attempt_requests: nullable(count),
      enabled_caps: enabledCapsSchema, estimated_required_caps: requiredCapsSchema,
    }),
    stop_reasons: array(enumeration(STOP_REASONS), 0, STOP_REASONS.length),
    diagnostics_truncated: booleanValue,
  }),
});
export type SearchResult = Infer<typeof resultShape>;
export type Excerpt = SearchResult['excerpts'][number];

function sum(values: number[], path: string): number {
  const total = values.reduce((acc, value) => acc + BigInt(value), 0n);
  requireContract(total <= BigInt(Number.MAX_SAFE_INTEGER), path, 'counter sum exceeds the safe integer range');
  return Number(total);
}

function validateResult(value: SearchResult, path: string): void {
  const { files, fragments: f, selection, usage: u, preflight: p, stop_reasons: reasons } = value.report;
  const report = value.report;
  const check = (condition: boolean, rule: string): void => requireContract(condition, `${path}.report`, rule);
  const evaluated = sum([f.remote_evaluated, f.cache_reused], path);
  const knownTotal = sum([evaluated, f.not_evaluated], path);
  check(evaluated === sum([f.below_threshold, f.above_threshold], path), 'successful evaluations must equal threshold categories');
  check(f.above_threshold === sum([f.represented_in_response, f.omitted_by_response_budget, f.omitted_stale], path),
    'qualifying fragments must equal represented, budget-omitted and stale categories');
  check(f.total === null || f.total === knownTotal, 'fragment total does not match terminal categories');
  check(report.inventory_complete || f.total === null, 'incomplete inventory requires an unknown fragment total');
  check(files.unreadable === 0 || f.total === null, 'unreadable source prevents a known prepared total');
  check(sum([files.eligible, ...Object.values(files.excluded_by_reason)], path) <= files.discovered,
    'eligible and excluded file counts exceed discovered files');
  check(files.unreadable <= files.discovered && files.changed_before_return <= files.eligible, 'file subset count exceeds its parent');
  check(knownTotal === 0 || files.eligible > 0, 'known fragments require an eligible file');
  check(f.omitted_stale === 0 || files.changed_before_return > 0, 'stale fragments require changed files');
  check(files.changed_before_return === 0 || reasons.includes('SOURCE_CHANGED'), 'changed files require SOURCE_CHANGED');
  check(selection.ranges_returned === value.excerpts.length, 'range count must equal excerpt count');
  check(selection.ranges_returned <= f.represented_in_response, 'ranges exceed represented fragments');
  check((f.represented_in_response === 0) === (value.excerpts.length === 0), 'represented fragments require returned ranges');
  check(selection.duplicate_ranges_collapsed <= f.above_threshold, 'collapsed duplicates exceed qualifying fragments');
  check(new Set(reasons).size === reasons.length, 'stop reasons must be unique');

  const canBeComplete = report.inventory_complete && f.total !== null && f.not_evaluated === 0
    && files.unreadable === 0 && files.changed_before_return === 0;
  check(!report.scope_fully_scanned || canBeComplete, 'full coverage contradicts inventory, evaluations or freshness');
  check((value.status === 'complete') === report.scope_fully_scanned, 'only complete status asserts full coverage');
  if (value.status === 'complete') {
    check(reasons.every((reason) => reason === 'USAGE_UNKNOWN' || reason === 'ESTIMATE_OVERRUN'), 'complete status contains a stopping failure');
  } else {
    check(reasons.length > 0, 'an incomplete result requires a reason');
  }
  if (value.status === 'rejected') {
    check(evaluated === 0 && u.provider_request_attempts === 0, 'preflight rejection cannot execute evaluations');
    check(reasons.includes('SCOPE_EXCEEDS_SCAN_BUDGET'), 'reported rejection requires the scan-budget reason');
    check(Object.keys(p.enabled_caps).length > 0, 'scan-budget rejection requires an enabled cap');
  }
  if (value.status === 'error') {
    check(evaluated === 0, 'fatal failure after a successful evaluation must be partial');
    check(reasons.some((reason) => Object.hasOwn(ERROR_DEFINITIONS, reason)
      && ERROR_DEFINITIONS[reason as ErrorCode][0] === 'error'), 'error status requires a fatal reason');
  }
  if (value.status === 'partial' && evaluated === 0) {
    const alwaysFatal = reasons.some((reason) => ['PROVIDER_AUTH', 'PROVIDER_QUOTA', 'RESOURCE_EXHAUSTED'].includes(reason));
    const executionStopped = reasons.some((reason) => ['DEADLINE', 'CANCELLED', 'SCAN_CAP_REACHED', 'PREPARATION_LIMIT'].includes(reason));
    const failedProvider = reasons.some((reason) => ['PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'INVALID_PROVIDER_RESPONSE'].includes(reason));
    check(!alwaysFatal && (!failedProvider || executionStopped), 'fatal failure without a successful evaluation requires error status');
  }
  const earlyRejection = reasons.some((reason) => ['INVALID_REQUEST', 'INVALID_CONFIG', 'UNAUTHORIZED_SCOPE',
    'REMOTE_DISABLED', 'CREDENTIAL_MISSING', 'BUSY', 'RESPONSE_BUDGET_TOO_SMALL'].includes(reason));
  check(!earlyRejection || value.status === 'rejected', 'early request or configuration failures must be rejected');

  const expectedSelection = value.status === 'rejected' ? 'preflight_rejected'
    : value.excerpts.length > 0 ? 'selected'
    : report.inventory_complete && f.total === 0 ? 'no_eligible_content'
    : evaluated === 0 ? 'no_successful_evaluation'
    : f.above_threshold === 0 ? 'no_score_above_threshold'
    : f.omitted_stale === f.above_threshold ? 'no_fresh_excerpt' : 'no_excerpt_fits';
  check(selection.outcome === expectedSelection, 'selection outcome violates empty-selection precedence');

  const seenRanges = new Set<string>();
  const hashes = new Map<string, string>();
  for (const excerpt of value.excerpts) {
    check(excerpt.score >= selection.threshold, 'returned score is below the selection threshold');
    check(report.scope.some((scope) => scope === '.' || excerpt.path === scope || excerpt.path.startsWith(`${scope}/`)),
      'excerpt is outside the requested scope');
    check(!hashes.has(excerpt.path) || hashes.get(excerpt.path) === excerpt.file_sha256, 'one file cannot have multiple returned snapshots');
    hashes.set(excerpt.path, excerpt.file_sha256);
    const key = JSON.stringify([excerpt.path, excerpt.start_line, excerpt.end_line]);
    check(!seenRanges.has(key), 'duplicate returned source range');
    seenRanges.add(key);
  }
  check(hashes.size <= files.eligible, 'returned files exceed eligible files');

  check(u.attempts_with_unknown_usage <= u.provider_request_attempts, 'unknown attempts exceed dispatched attempts');
  check(u.provider_input_tokens_reported === (u.attempts_with_unknown_usage === 0 ? u.provider_input_tokens_known_subtotal : null),
    'all-attempt usage must be null if any attempt has unknown usage');
  check(u.provider_input_tokens_estimated >= u.provider_input_tokens_known_subtotal, 'estimate cannot erase known usage');
  check(u.provider_input_tokens_estimated >= sum([u.provider_input_tokens_known_subtotal, u.attempts_with_unknown_usage], path),
    'each unknown dispatched attempt must retain a positive token reservation');
  check(u.attempts_with_unknown_usage > 0 || u.provider_input_tokens_estimated === u.provider_input_tokens_known_subtotal,
    'fully known usage must replace token reservations');
  check(u.attempts_with_unknown_usage < u.provider_request_attempts || u.provider_input_tokens_known_subtotal === 0,
    'no known attempts can contribute a known token subtotal');
  check(u.attempts_with_unknown_usage === 0 || reasons.includes('USAGE_UNKNOWN'), 'unknown usage requires USAGE_UNKNOWN');
  check(f.remote_evaluated === 0 || u.provider_request_attempts > 0, 'remote evaluations require a provider attempt');
  if (u.provider_request_attempts === 0) {
    check(u.provider_input_tokens_estimated === 0 && u.transmitted_bytes === 0
      && (u.estimated_cost_usd === null || u.estimated_cost_usd === 0)
      && (u.reported_cost_usd === null || u.reported_cost_usd === 0), 'zero-call searches cannot report incurred usage');
  }

  const enabledKeys = Object.keys(p.enabled_caps).sort();
  check(JSON.stringify(enabledKeys) === JSON.stringify(Object.keys(p.estimated_required_caps).sort()), 'cap maps must have exactly the same keys');
  if (f.total !== null) {
    check(p.planned_remote_fragments !== null && sum([p.planned_remote_fragments, p.planned_cache_hits], path) === f.total,
      'preflight remote fragments and potential cache hits must partition the prepared total');
    check(p.estimated_first_attempt_tokens !== null && p.estimated_first_attempt_requests !== null, 'finished preparation requires first-attempt estimates');
    check(Object.values(p.estimated_required_caps).every((required) => required !== null), 'known preparation cannot have unknown cap requirements');
  } else {
    check(p.planned_remote_fragments === null, 'incomplete preparation cannot claim an exact full remote plan');
  }
  const comparableRequirements = {
    fragments: f.total,
    request_attempts: p.estimated_first_attempt_requests,
    estimated_input_tokens: p.estimated_first_attempt_tokens,
    estimated_cost_usd: p.estimated_first_attempt_cost_usd,
  };
  for (const key of Object.keys(comparableRequirements) as Array<keyof typeof comparableRequirements>) {
    check(!Object.hasOwn(p.enabled_caps, key) || p.estimated_required_caps[key] === comparableRequirements[key],
      'required cap quantity disagrees with its preflight estimate');
  }
  if (value.status === 'rejected') {
    check((enabledKeys as ScanCap[]).some((key) => {
      const required = p.estimated_required_caps[key];
      const enabled = p.enabled_caps[key];
      return required === null ? reasons.includes('PREPARATION_LIMIT')
        : required !== undefined && enabled !== undefined && required > enabled;
    }), 'preflight rejection must identify an exceeded cap or incomplete limited preparation');
  }
}

export const searchResultSchema = refine(resultShape, validateResult);

export const searchErrorSchema = refine(object({
  schema_version: version,
  search_id: identifier,
  status: enumeration(['rejected', 'error']),
  error: object({ code: enumeration(ERROR_CODES), message: textValue(2_048), retryable: booleanValue }),
}), (value, path) => {
  const [status, retryable, message] = ERROR_DEFINITIONS[value.error.code];
  requireContract(value.status === status && value.error.retryable === retryable && value.error.message === message,
    path, 'error status, retry advice and guidance must match the documented code');
  requireContract(Buffer.byteLength(JSON.stringify(value)) <= CONTRACT_LIMITS.error_bytes, path, 'compact error exceeds its byte budget');
});
export type SearchError = Infer<typeof searchErrorSchema>;
export type SearchOutcome = SearchResult | SearchError;
export const searchOutcomeSchema = schema<SearchOutcome>((input, path) => {
  return typeof input === 'object' && input !== null && Object.hasOwn(input, 'error')
    ? searchErrorSchema.parse(input, path) : searchResultSchema.parse(input, path);
});

export function createSearchError(code: ErrorCode, searchId: string): SearchError {
  const [status, retryable, message] = ERROR_DEFINITIONS[code];
  return searchErrorSchema.parse({ schema_version: SCHEMA_VERSION, search_id: searchId, status, error: { code, message, retryable } });
}

export const DIAGNOSTIC_CODES = [...STOP_REASONS, 'PARSE_FALLBACK', 'CACHE_MISS', 'CACHE_UNAVAILABLE', 'EXCLUDED_DIRECTORY'] as const;
export const diagnosticsSchema = object({
  schema_version: version,
  search_id: identifier,
  events: array(object({ code: enumeration(DIAGNOSTIC_CODES), elapsed_ms: count }, {
    count, path: excerptPath,
  }), 0, CONTRACT_LIMITS.diagnostic_events),
  excluded_directories_by_reason: codeMap(EXCLUSION_REASONS, count),
  observed_cap_lower_bounds: enabledCapsSchema,
  response_tokens_measured: nullable(count),
  truncated: booleanValue,
});
export type Diagnostics = Infer<typeof diagnosticsSchema>;
