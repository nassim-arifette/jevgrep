import './helpers/offline-preload.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countReferenceTokens, referenceCounter } from '../src/response/token-counter.ts';
import { toCliSearchResponse, toMcpSearchResponse } from '../src/search-response.ts';
import { resultFixture } from './fixtures/contracts.ts';

test('the pinned cl100k_base vocabulary counts Unicode and literal special markers offline', () => {
  assert.equal(referenceCounter.id, 'tiktoken@1.0.22/cl100k_base');
  const vectors: readonly (readonly [string, number])[] = [
    ['', 0], ['hello world', 2], ['antidisestablishmentarianism', 6],
    ['お誕生日おめでとう', 9], ['🎯', 3], ['e\u0301', 2], ['é', 1],
    ['<|endoftext|>', 7], ['a\r\nb', 3],
    [JSON.stringify({ code: 'const x = "é";\r\n\\ 🎯 <|endoftext|>' }), 23],
  ];
  for (const [text, expected] of vectors) assert.equal(countReferenceTokens(text), expected);
  assert.throws(() => globalThis.fetch('https://example.invalid'), /offline guard/);
});

test('BPE deletion is not monotone; the budget renderer must remeasure', () => {
  assert.equal(countReferenceTokens('establish'), 1);
  assert.equal(countReferenceTokens('stablish'), 2);
});

test('both response adapters accept the same measured JSON with the pinned tokenizer', () => {
  const result = resultFixture();
  result.report.response_budget.counter = referenceCounter.id;
  const cli = toCliSearchResponse(result, referenceCounter);
  const mcp = toMcpSearchResponse(result, referenceCounter);
  assert.equal(cli.stdout, mcp.content[0].text);
  assert.ok(countReferenceTokens(cli.stdout) <= result.report.response_budget.requested_tokens);
  assert.deepEqual(JSON.parse(cli.stdout), result);
});
