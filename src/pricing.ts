/**
 * USD estimation policy shared by `inspect` and search reports.
 *
 * Public USD values are decimals backed by integer nanodollars (see contracts.ts).
 * An estimate is rounded up to the next nanodollar, so a sub-unit cost is never
 * reported as free and a USD cap is never under-counted.
 */
const NANODOLLARS_PER_USD = 1_000_000_000n;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;

/** Estimated input cost in USD for `tokens` at a dated rate, or null without a pricing record. */
export function estimateInputCostUsd(tokens: number, usdPerMillionTokens: number | null): number | null {
  if (usdPerMillionTokens === null) return null;
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError(`token count must be a non-negative safe integer, got ${String(tokens)}`);
  }
  const nanodollarsPerMillion = BigInt(Math.round(usdPerMillionTokens * Number(NANODOLLARS_PER_USD)));
  const nanodollars = (BigInt(tokens) * nanodollarsPerMillion + TOKENS_PER_PRICE_UNIT - 1n) / TOKENS_PER_PRICE_UNIT;
  return Number(nanodollars) / Number(NANODOLLARS_PER_USD);
}
