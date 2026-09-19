import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_LIMITS, ContractValidationError, ERROR_CODES, createSearchError,
  diagnosticsSchema, searchErrorSchema, searchOutcomeSchema,
} from '../../src/contracts.ts';
import type { Diagnostics } from '../../src/contracts.ts';
import { toCliSearchResponse, toMcpSearchResponse } from '../../src/search-response.ts';
import type { ResponseTokenCounter } from '../../src/search-response.ts';
import {
  invalidDiagnostics, invalidError, RESULT_FIXTURES, resultFixture, validDiagnostics, validError,
} from '../fixtures/contracts.ts';

// Deliberately synthetic: this is not the production reference tokenizer (JG-006).
const counter: ResponseTokenCounter = { id: 'fixture-byte-counter@1', count: (text) => Buffer.byteLength(text) };

test('compact error examples are strict, versioned and use fixed recovery guidance', () => {
  assert.deepEqual(searchErrorSchema.parse(validError), validError);
  assert.deepEqual(createSearchError('INVALID_REQUEST', 'fixture-1'), validError);
  assert.equal(searchErrorSchema.safeParse(invalidError).success, false);
  for (const code of ERROR_CODES) {
    const error = createSearchError(code, 'fixture-1');
    assert.deepEqual(searchOutcomeSchema.parse(error), error);
    assert.ok(Buffer.byteLength(JSON.stringify(error)) <= CONTRACT_LIMITS.error_bytes);
    assert.ok(counter.count(JSON.stringify(error)) <= CONTRACT_LIMITS.error_tokens);
  }
  for (const input of [
    { ...validError, status: 'complete' }, { ...validError, status: 'error' },
    { ...validError, schema_version: 1 }, { ...validError, search_id: 'x'.repeat(129) },
    { ...validError, error: { ...validError.error, retryable: true } },
    { ...validError, error: { ...validError.error, message: 'raw provider body or credential' } },
    { ...validError, error: { ...validError.error, cause: 'raw body' } },
    { ...validError, report: resultFixture().report },
  ]) assert.throws(() => searchErrorSchema.parse(input), ContractValidationError);
});

test('diagnostics are bounded metadata with optional explicit local paths', () => {
  assert.deepEqual(diagnosticsSchema.parse(validDiagnostics), validDiagnostics);
  assert.equal(diagnosticsSchema.safeParse(invalidDiagnostics).success, false);
  const diagnostic: Diagnostics = structuredClone(validDiagnostics);
  diagnostic.events = [{ code: 'SOURCE_CHANGED', elapsed_ms: 100, path: 'src/cache.ts' }];
  diagnostic.response_tokens_measured = 512;
  assert.deepEqual(diagnosticsSchema.parse(diagnostic), diagnostic);
  for (const input of [
    { ...diagnostic, events: Array(65).fill({ code: 'CACHE_MISS', elapsed_ms: 0 }) },
    { ...diagnostic, events: [{ code: 'arbitrary', elapsed_ms: 0 }] },
    { ...diagnostic, events: [{ code: 'CACHE_MISS', elapsed_ms: -1 }] },
    { ...diagnostic, events: [{ code: 'CACHE_MISS', elapsed_ms: 0, path: 'C:/private' }] },
    { ...diagnostic, query: 'private question' },
    { ...diagnostic, excluded_directories_by_reason: { arbitrary: 1 } },
    { ...diagnostic, observed_cap_lower_bounds: { request_attempts: null } },
    { ...diagnostic, response_tokens_measured: -1 },
    { ...diagnostic, schema_version: '2' },
  ]) assert.throws(() => diagnosticsSchema.parse(input), ContractValidationError);
});

test('CLI and MCP use exactly the same validated serialization for every outcome', () => {
  for (const outcome of [...RESULT_FIXTURES.map(resultFixture), ...ERROR_CODES.map((code) => createSearchError(code, 'fixture-1'))]) {
    const cli = toCliSearchResponse(outcome, counter);
    const mcp = toMcpSearchResponse(outcome, counter);
    assert.deepEqual(mcp.content, [{ type: 'text', text: cli.stdout }]);
    assert.deepEqual(JSON.parse(cli.stdout), outcome);
    assert.equal(mcp.isError, outcome.status === 'rejected' || outcome.status === 'error');
    const cancelled = 'error' in outcome && outcome.error.code === 'CANCELLED';
    assert.equal(cli.exitCode, cancelled ? 130 : { complete: 0, partial: 3, rejected: 2, error: 4 }[outcome.status]);
    assert.equal(Object.hasOwn(mcp, 'structuredContent'), false);
  }
});

test('the entire escaped payload is counted and the count stays outside the payload', () => {
  const result = resultFixture();
  const excerpt = result.excerpts[0];
  assert.ok(excerpt);
  excerpt.code = '\t"quoted"\\path\r\n😀';
  let measured = '';
  const captured: ResponseTokenCounter = { id: counter.id, count(text) { measured = text; return 4_000; } };
  const cli = toCliSearchResponse(result, captured);
  assert.equal(measured, cli.stdout);
  assert.equal(JSON.parse(measured).excerpts[0].code, excerpt.code);
  assert.equal(Object.hasOwn(JSON.parse(measured).report, 'response_tokens_measured'), false);
  assert.throws(() => toCliSearchResponse(result, { id: counter.id, count: () => 4_001 }), /budget/);
  assert.throws(() => toMcpSearchResponse(validError, { id: counter.id, count: () => 1_025 }), /budget/);
});

test('both adapters reject invalid contracts, counter identities and invalid counts', () => {
  for (const render of [toCliSearchResponse, toMcpSearchResponse]) {
    assert.throws(() => render(invalidError, counter), ContractValidationError);
    assert.throws(() => render(resultFixture(), { id: 'different@1', count: () => 0 }), /identity/);
    for (const tokens of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => render(resultFixture(), { id: counter.id, count: () => tokens }), ContractValidationError);
    }
  }
});
