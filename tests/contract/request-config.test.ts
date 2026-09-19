import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractValidationError, SCAN_CAP_KEYS, configurationSchema, createDefaultConfiguration,
  createSearchRequestSchema, parseSearchRequest, searchRequestSchema,
} from '../../src/contracts.ts';
import type { Configuration } from '../../src/contracts.ts';
import { invalidConfiguration, invalidRequest, validConfiguration, validRequest } from '../fixtures/contracts.ts';

test('request validation preserves exact query bytes, defaults and caller-owned input', () => {
  const original = structuredClone(validRequest);
  const parsed = parseSearchRequest(validRequest);
  assert.deepEqual(validRequest, original);
  assert.equal(parsed.query, original.query);
  assert.deepEqual(parsed.scope, ['src', 'tests']);
  assert.deepEqual(parseSearchRequest({ query: ' Find it\r\n' }), {
    query: ' Find it\r\n', scope: ['.'], max_context_tokens: 4_000, allow_partial_scan: false,
  });
  assert.equal(searchRequestSchema.safeParse(validRequest).success, true);
  assert.equal(searchRequestSchema.safeParse(invalidRequest).success, false);
});

test('scope canonicalization is deterministic and compares path segments', () => {
  assert.deepEqual(parseSearchRequest({ query: 'q', scope: ['src/cache.ts', 'src2', 'src\\nested', './src/', 'src'] }).scope, ['src', 'src2']);
  assert.deepEqual(parseSearchRequest({ query: 'q', scope: ['src', '.', 'tests'] }).scope, ['.']);
  assert.deepEqual(parseSearchRequest({ query: 'q', scope: ['a//b', './a/b', 'é/😀.ts'] }).scope, ['a/b', 'é/😀.ts']);
});

test('invalid request shapes, values and unknown keys are rejected without coercion', () => {
  const invalid: unknown[] = [
    undefined, null, [], 'q', {}, { query: '' }, { query: ' \t\r\n' }, { query: 1 }, { query: '\ud800' },
    { query: 'q', api_key: 'secret' }, { query: 'q', scope: [] }, { query: 'q', scope: 'src' },
    { query: 'q', scope: [null] }, { query: 'q', scope: [' '] }, { query: 'q', scope: Array(33).fill('src') },
    { query: 'q', scope: new Array(1) }, { query: 'q', allow_partial_scan: 'true' },
    { query: 'q', allow_partial_scan: null }, { query: 'q', scope: undefined },
    ...[0, -1, 1_023, 16_001, 1_024.5, NaN, Infinity, '4000', null, Number.MAX_SAFE_INTEGER + 1]
      .map((max_context_tokens) => ({ query: 'q', max_context_tokens })),
  ];
  for (const input of invalid) assert.throws(() => parseSearchRequest(input), ContractValidationError);
  for (const budget of [1_024, 4_000, 16_000]) assert.equal(parseSearchRequest({ query: 'q', max_context_tokens: budget }).max_context_tokens, budget);
});

test('scope lexical checks reject Windows and POSIX escapes on either host', () => {
  for (const path of ['..', '../a', 'a/../b', 'a\\..\\b', '/etc', '\\root', 'C:\\repo', 'C:repo',
    '//server/share', '\\\\server\\share', '\\\\?\\C:\\repo', '\\\\.\\NUL', 'file:stream', 'file\0.ts',
    'a\n.ts', 'src/*', 'NUL', 'con.txt', 'src/COM1.ts', 'LPT¹', 'a.', 'a /b']) {
    assert.throws(() => parseSearchRequest({ query: 'q', scope: [path] }), ContractValidationError, path);
  }
});

test('UTF-8 limits apply before scope deduplication and count bytes, not UTF-16 units', () => {
  assert.equal(parseSearchRequest({ query: 'é'.repeat(4_096) }).query.length, 4_096);
  assert.throws(() => parseSearchRequest({ query: 'é'.repeat(4_097) }), ContractValidationError);
  assert.equal(parseSearchRequest({ query: '😀'.repeat(2_048) }).query.length, 4_096);
  assert.throws(() => parseSearchRequest({ query: '😀'.repeat(2_049) }), ContractValidationError);
  const scope = ['a'.repeat(2_048), 'é'.repeat(1_024)];
  assert.equal(parseSearchRequest({ query: 'q', scope }).scope.length, 2);
  assert.throws(() => parseSearchRequest({ query: 'q', scope: [...scope, 'a'] }), ContractValidationError);
  assert.throws(() => parseSearchRequest({ query: 'q', scope: ['a'.repeat(3_000), 'a'.repeat(3_000)] }), ContractValidationError);
});

test('operator response settings control request defaults and maximum', () => {
  const limits = { default_response_tokens: 6_000, max_response_tokens: 20_000 };
  assert.equal(parseSearchRequest({ query: 'q' }, limits).max_context_tokens, 6_000);
  assert.equal(parseSearchRequest({ query: 'q', max_context_tokens: 20_000 }, limits).max_context_tokens, 20_000);
  assert.throws(() => parseSearchRequest({ query: 'q', max_context_tokens: 20_001 }, limits), ContractValidationError);
  assert.throws(() => createSearchRequestSchema({ default_response_tokens: 5_000, max_response_tokens: 4_000 }), ContractValidationError);
});

test('configuration has explicit defaults, disabled disclosure and no default optional cap', () => {
  assert.deepEqual(createDefaultConfiguration(validConfiguration.repository_root, validConfiguration.provider.model), validConfiguration);
  assert.deepEqual(configurationSchema.parse(validConfiguration), validConfiguration);
  assert.equal(configurationSchema.safeParse(invalidConfiguration).success, false);
  assert.equal(createDefaultConfiguration('/work/synthetic', 'synthetic-model-v1').repository_root, '/work/synthetic');
});

test('null disables a cap; zero remains a real cap; USD caps require matching dated pricing', () => {
  const config: Configuration = structuredClone(validConfiguration);
  config.provider.pricing = {
    model: config.provider.model, verified_at: '2026-09-19', input_usd_per_million_tokens: 0.042, output_usd_per_million_tokens: 0,
  };
  for (const key of SCAN_CAP_KEYS) {
    config.scan_caps[key] = 0;
    assert.equal(configurationSchema.parse(config).scan_caps[key], 0, key);
    config.scan_caps[key] = null;
    assert.equal(configurationSchema.parse(config).scan_caps[key], null, key);
  }
  config.scan_caps.estimated_cost_usd = 0;
  config.provider.pricing = null;
  assert.throws(() => configurationSchema.parse(config), /pricing/);
  config.provider.pricing = { model: 'other-model', verified_at: '2026-09-19', input_usd_per_million_tokens: 0, output_usd_per_million_tokens: 0 };
  assert.throws(() => configurationSchema.parse(config), /pricing/);
  config.provider.pricing.model = config.provider.model;
  for (const amount of [0, 1e-9, 0.1, 0.1 + 0.2]) {
    config.scan_caps.estimated_cost_usd = amount;
    assert.equal(configurationSchema.parse(config).scan_caps.estimated_cost_usd, amount);
  }
  for (const amount of [1e-10, 1e-30, 0.0000000015, 10_000_000]) {
    config.scan_caps.estimated_cost_usd = amount;
    assert.throws(() => configurationSchema.parse(config), ContractValidationError);
  }
});

test('every configuration nesting rejects unknown keys and unsafe or unsupported values', () => {
  const invalid: unknown[] = [
    { ...validConfiguration, schema_version: '1' }, { ...validConfiguration, repository_root: 'relative' },
    { ...validConfiguration, repository_root: 'C:relative' }, { ...validConfiguration, repository_root: '/work/../private' },
    { ...validConfiguration, api_key: 'secret' },
    { ...validConfiguration, provider: { ...validConfiguration.provider, api_key: 'secret' } },
    { ...validConfiguration, search: { ...validConfiguration.search, default_response_tokens: 20_000 } },
    { ...validConfiguration, search: { ...validConfiguration.search, require_fit: false } },
    { ...validConfiguration, search: { ...validConfiguration.search, concurrency: 0 } },
    { ...validConfiguration, search: { ...validConfiguration.search, deadline_ms: 0 } },
    { ...validConfiguration, search: { ...validConfiguration.search, threshold: NaN } },
    { ...validConfiguration, source: { ...validConfiguration.source, max_file_bytes: 0 } },
    { ...validConfiguration, logging: { ...validConfiguration.logging, include_source: true } },
    { ...validConfiguration, cache: { ...validConfiguration.cache, max_bytes: -1 } },
    { ...validConfiguration, scan_caps: {} },
    ...['provider', 'search', 'scan_caps', 'source', 'cache', 'logging'].map((key) => ({
      ...validConfiguration, [key]: { ...Reflect.get(validConfiguration, key) as object, extra: 1 },
    })),
  ];
  for (const input of invalid) assert.throws(() => configurationSchema.parse(input), ContractValidationError);
  for (const key of SCAN_CAP_KEYS) {
    for (const value of [-1, Infinity, NaN, '1', undefined, ...(key === 'estimated_cost_usd' ? [] : [0.5])]) {
      assert.throws(() => configurationSchema.parse({ ...validConfiguration, scan_caps: { ...validConfiguration.scan_caps, [key]: value } }), ContractValidationError);
    }
  }
});

test('provider settings accept only the documented endpoint and well-formed rate cards', () => {
  for (const base_url of ['http://api.typesafe.ai', 'https://api.typesafe.ai.evil.test', 'https://key@api.typesafe.ai',
    'https://api.typesafe.ai?key=secret', 'https://api.typesafe.ai:444', 'https://custom.test']) {
    assert.throws(() => configurationSchema.parse({ ...validConfiguration, provider: { ...validConfiguration.provider, base_url } }), ContractValidationError);
  }
  for (const verified_at of ['2026-02-30', 'yesterday', '2026-13-01']) {
    assert.throws(() => configurationSchema.parse({ ...validConfiguration, provider: { ...validConfiguration.provider,
      pricing: { model: validConfiguration.provider.model, verified_at, input_usd_per_million_tokens: 0.042, output_usd_per_million_tokens: 0 },
    } }), ContractValidationError);
  }
});

test('validators reject executable properties and do not echo unknown keys or values', () => {
  const secret = 'secret-synthetic-123';
  assert.throws(() => searchRequestSchema.parse({ query: 'q', [secret]: secret }), (error: unknown) => {
    assert.ok(error instanceof ContractValidationError);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  let called = false;
  const accessor = { get query(): string { called = true; return 'q'; } };
  assert.throws(() => searchRequestSchema.parse(accessor), ContractValidationError);
  const scopeAccessor = ['src'];
  Object.defineProperty(scopeAccessor, '0', { get() { called = true; return 'src'; } });
  assert.throws(() => searchRequestSchema.parse({ query: 'q', scope: scopeAccessor }), ContractValidationError);
  assert.equal(called, false);
  assert.throws(() => searchRequestSchema.parse({ query: 'q', scope: Object.assign(['src'], { hidden: secret }) }), ContractValidationError);
  assert.throws(() => searchRequestSchema.parse({ query: 'q', [Symbol('hidden')]: 1 }), ContractValidationError);
  assert.throws(() => searchRequestSchema.parse(Object.create({ query: 'q' })), ContractValidationError);
  assert.throws(() => searchRequestSchema.parse(JSON.parse('{"query":"q","__proto__":{}}')), ContractValidationError);
});
