import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractValidationError, searchOutcomeSchema, searchResultSchema } from '../../src/contracts.ts';
import type { SearchResult } from '../../src/contracts.ts';
import { invalidResult, RESULT_FIXTURES, resultFixture } from '../fixtures/contracts.ts';

for (const kind of RESULT_FIXTURES) {
  test(`valid result example: ${kind}`, () => {
    const result = resultFixture(kind);
    assert.deepEqual(searchResultSchema.parse(result), result);
    assert.deepEqual(searchOutcomeSchema.parse(JSON.parse(JSON.stringify(result))), result);
  });
}

test('completed response omissions do not imply incomplete coverage', () => {
  const result = searchResultSchema.parse(resultFixture('no_excerpt_fits'));
  assert.equal(result.status, 'complete');
  assert.equal(result.report.scope_fully_scanned, true);
  assert.equal(result.report.fragments.omitted_by_response_budget, 1);
});

test('preflight cache hits are potential reuse and do not count as executed evaluations', () => {
  const result = searchResultSchema.parse(resultFixture('rejected'));
  assert.equal(result.report.preflight.planned_cache_hits, 1);
  assert.equal(result.report.fragments.cache_reused, 0);
  assert.equal(result.report.fragments.not_evaluated, 2);
  assert.equal(result.report.usage.provider_request_attempts, 0);
  assert.equal(result.report.usage.provider_input_tokens_reported, 0);
});

test('unknown usage preserves the known subtotal and conservative estimate', () => {
  const { usage } = searchResultSchema.parse(resultFixture('unknown_usage')).report;
  assert.equal(usage.provider_input_tokens_reported, null);
  assert.equal(usage.provider_input_tokens_known_subtotal, 100);
  assert.equal(usage.provider_input_tokens_estimated, 180);
  assert.equal(usage.reported_cost_usd, null);
});

const invalidChanges: ReadonlyArray<readonly [string, (result: SearchResult) => void]> = [
  ['total identity', (r) => { r.report.fragments.total = 3; }],
  ['threshold identity', (r) => { r.report.fragments.below_threshold = 0; }],
  ['qualifying identity', (r) => { r.report.fragments.omitted_by_response_budget = 1; }],
  ['negative count', (r) => { r.report.fragments.not_evaluated = -1; }],
  ['fractional count', (r) => { r.report.usage.elapsed_ms = 0.5; }],
  ['unsafe count', (r) => { r.report.files.discovered = Number.MAX_SAFE_INTEGER + 1; }],
  ['overflowing sum', (r) => { r.report.fragments.remote_evaluated = Number.MAX_SAFE_INTEGER; r.report.fragments.cache_reused = 1; }],
  ['range count', (r) => { r.report.selection.ranges_returned = 0; }],
  ['empty-selection precedence', (r) => { r.report.selection.outcome = 'no_score_above_threshold'; }],
  ['incomplete inventory total', (r) => { r.report.inventory_complete = false; }],
  ['false complete coverage', (r) => { r.report.scope_fully_scanned = false; }],
  ['false partial coverage', (r) => { r.status = 'partial'; r.report.stop_reasons = ['DEADLINE']; }],
  ['failure marked complete', (r) => { r.report.stop_reasons = ['DEADLINE']; }],
  ['unreadable files', (r) => { r.report.files.unreadable = 1; }],
  ['exclusion/file counts', (r) => { r.report.files.excluded_by_reason = { binary: 1 }; }],
  ['changed file count', (r) => { r.report.files.changed_before_return = 2; }],
  ['unbounded reason list', (r) => { r.report.stop_reasons = Array(100).fill('USAGE_UNKNOWN'); }],
  ['duplicate reasons', (r) => { r.report.stop_reasons = ['USAGE_UNKNOWN', 'USAGE_UNKNOWN']; }],
  ['unknown all-attempt usage', (r) => { r.report.usage.provider_input_tokens_reported = null; }],
  ['erased known usage', (r) => { r.report.usage.provider_input_tokens_estimated = 99; }],
  ['more unknown than dispatched', (r) => { r.report.usage.attempts_with_unknown_usage = 2; }],
  ['null fabricated as zero', (r) => { r.report.usage.attempts_with_unknown_usage = 1; r.report.usage.provider_input_tokens_reported = 0; }],
  ['no attempt for remote score', (r) => { r.report.usage.provider_request_attempts = 0; }],
  ['cap key identity', (r) => { r.report.preflight.enabled_caps = { request_attempts: 1 }; }],
  ['unknown required cap after preparation', (r) => {
    r.report.preflight.enabled_caps = { request_attempts: 1 }; r.report.preflight.estimated_required_caps = { request_attempts: null };
  }],
  ['preflight partition', (r) => { r.report.preflight.planned_cache_hits = 1; }],
  ['unknown plan after preparation', (r) => { r.report.preflight.planned_remote_fragments = null; }],
  ['fatal with surviving scores', (r) => { r.status = 'error'; r.report.scope_fully_scanned = false; r.report.stop_reasons = ['PROVIDER_AUTH']; }],
  ['rejection after dispatch', (r) => { r.status = 'rejected'; r.report.scope_fully_scanned = false; r.report.stop_reasons = ['SCOPE_EXCEEDS_SCAN_BUDGET']; }],
];

for (const [name, change] of invalidChanges) {
  test(`reject inconsistent result: ${name}`, () => {
    const result = resultFixture();
    change(result);
    assert.throws(() => searchResultSchema.parse(result), ContractValidationError);
  });
}

test('score failures are unavailable evaluations, never fabricated score zero', () => {
  const result = resultFixture();
  const excerpt = result.excerpts[0];
  assert.ok(excerpt);
  for (const score of [null, undefined, '0.8', -0.1, 1.1, NaN, Infinity]) {
    assert.throws(() => searchResultSchema.parse({ ...result, excerpts: [{ ...excerpt, score }] }), ContractValidationError);
  }
  excerpt.score = 0;
  result.report.selection.threshold = 0;
  assert.equal(searchResultSchema.parse(result).excerpts[0]?.score, 0);
});

test('excerpt provenance, line bounds, scope and original text are validated without rewriting', () => {
  const result = resultFixture();
  const excerpt = result.excerpts[0];
  assert.ok(excerpt);
  excerpt.code = '\ufeff  const x = "😀";\r\n';
  assert.equal(searchResultSchema.parse(result).excerpts[0]?.code, excerpt.code);
  for (const fields of [
    { start_line: 0 }, { end_line: 1 }, { end_line: 2.5 }, { file_sha256: 'bad' },
    { path: '/outside.ts' }, { path: 'src2/cache.ts' }, { path: 'src\\cache.ts' }, { code: '' }, { code: '\ud800' },
  ]) {
    assert.throws(() => searchResultSchema.parse({ ...result, excerpts: [{ ...excerpt, ...fields }] }), ContractValidationError);
  }
});

test('all report objects and finite-key maps reject undocumented fields', () => {
  assert.equal(searchResultSchema.safeParse(invalidResult).success, false);
  const result = resultFixture();
  const invalid: unknown[] = [
    { ...result, extra: true }, { ...result, report: { ...result.report, raw_provider_body: 'secret' } },
    ...['files', 'fragments', 'selection', 'usage', 'response_budget', 'preflight'].map((key) => ({
      ...result, report: { ...result.report, [key]: { ...Reflect.get(result.report, key) as object, extra: true } },
    })),
    { ...result, report: { ...result.report, files: { ...result.report.files, excluded_by_reason: { arbitrary: 1 } } } },
    { ...result, report: { ...result.report, preflight: { ...result.report.preflight, enabled_caps: { arbitrary: 1 } } } },
    { ...result, report: { ...result.report, stop_reasons: ['raw provider message'] } },
    { ...result, report: { ...result.report, scope: ['src/cache.ts', 'src'] } },
  ];
  for (const input of invalid) assert.throws(() => searchResultSchema.parse(input), ContractValidationError);
});

test('an incomplete inventory uses lower bounds and cannot assert absence', () => {
  const result = resultFixture('deadline');
  result.report.inventory_complete = false;
  result.report.fragments.total = null;
  result.report.preflight.planned_remote_fragments = null;
  result.report.preflight.estimated_first_attempt_tokens = null;
  result.report.preflight.estimated_first_attempt_requests = null;
  result.report.preflight.enabled_caps = { fragments: 0 };
  result.report.preflight.estimated_required_caps = { fragments: null };
  assert.equal(searchResultSchema.parse(result).report.fragments.total, null);
  result.report.selection.outcome = 'no_eligible_content';
  assert.throws(() => searchResultSchema.parse(result), ContractValidationError);
});

test('deadline without a score is partial; fatal failure without a score is error', () => {
  const deadline = resultFixture('deadline');
  assert.equal(searchResultSchema.parse(deadline).status, 'partial');
  deadline.status = 'error';
  assert.throws(() => searchResultSchema.parse(deadline), ContractValidationError);
  assert.equal(searchResultSchema.parse(resultFixture('error')).status, 'error');
  const fatal = resultFixture('error');
  fatal.status = 'partial';
  assert.throws(() => searchResultSchema.parse(fatal), ContractValidationError);
});

test('a scan-budget rejection explains a real exceeded allowance', () => {
  const result = resultFixture('rejected');
  result.report.preflight.enabled_caps.request_attempts = 2;
  assert.throws(() => searchResultSchema.parse(result), ContractValidationError);
  result.report.preflight.estimated_required_caps.request_attempts = 3;
  assert.throws(() => searchResultSchema.parse(result), ContractValidationError);
});

test('full known usage replaces estimates; an unknown attempt retains its reservation', () => {
  const known = resultFixture();
  known.report.usage.provider_input_tokens_estimated = 101;
  assert.throws(() => searchResultSchema.parse(known), ContractValidationError);
  assert.equal(searchResultSchema.parse(resultFixture('unknown_usage')).report.usage.provider_input_tokens_estimated, 180);
});

test('zero-call and all-unknown cases cannot manufacture reported or incurred usage', () => {
  const noCalls = resultFixture('rejected');
  noCalls.report.usage.provider_input_tokens_estimated = 100;
  assert.throws(() => searchResultSchema.parse(noCalls), ContractValidationError);
  const unknown = resultFixture('error');
  unknown.report.usage.provider_input_tokens_known_subtotal = 1;
  assert.throws(() => searchResultSchema.parse(unknown), ContractValidationError);
});

test('unknown dispatched attempts cannot lose their entire token reservation', () => {
  const allUnknown = resultFixture('error');
  allUnknown.report.usage.provider_input_tokens_estimated = 0;
  assert.throws(() => searchResultSchema.parse(allUnknown), /positive token reservation/);
  const mixed = resultFixture('unknown_usage');
  mixed.report.usage.provider_input_tokens_estimated = mixed.report.usage.provider_input_tokens_known_subtotal;
  assert.throws(() => searchResultSchema.parse(mixed), /positive token reservation/);
});

test('early input/configuration rejections cannot be misreported as partial successes', () => {
  for (const reason of ['INVALID_REQUEST', 'INVALID_CONFIG', 'UNAUTHORIZED_SCOPE', 'REMOTE_DISABLED',
    'CREDENTIAL_MISSING', 'BUSY', 'RESPONSE_BUDGET_TOO_SMALL'] as const) {
    const result = resultFixture('deadline');
    result.report.stop_reasons = [reason];
    assert.throws(() => searchResultSchema.parse(result), /must be rejected/);
  }
});
