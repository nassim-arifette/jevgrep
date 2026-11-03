import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateInputCostUsd } from '../src/pricing.ts';

test('no pricing record yields no USD estimate', () => {
  assert.equal(estimateInputCostUsd(1_000, null), null);
});

test('USD estimates round up to the next nanodollar', () => {
  assert.equal(estimateInputCostUsd(0, 0.042), 0);
  assert.equal(estimateInputCostUsd(1_000_000, 0.042), 0.042);
  assert.equal(estimateInputCostUsd(1, 0.042), 4.2e-8);
  // 1 token at $0.0000001 per million is 0.0001 nanodollars: never reported as free.
  assert.equal(estimateInputCostUsd(1, 0.0000001), 1e-9);
  // 5 tokens at $0.15 per million is 750 nanodollars, which six decimals would round to 0.000001.
  assert.equal(estimateInputCostUsd(5, 0.15), 7.5e-7);
});

test('estimates stay representable as contract USD amounts', () => {
  for (const tokens of [1, 7, 999, 123_457, 9_999_999]) {
    const usd = estimateInputCostUsd(tokens, 0.15);
    assert.ok(usd !== null && Number.isSafeInteger(Math.round(usd * 1e9)));
    assert.ok(Math.abs(usd * 1e9 - Math.round(usd * 1e9)) < 1e-6);
    assert.ok(usd * 1_000_000 >= tokens * 0.15 - 1e-12, 'never under the exact cost');
  }
});

test('invalid token counts are refused', () => {
  for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => estimateInputCostUsd(tokens, 0.042), RangeError);
  }
});
