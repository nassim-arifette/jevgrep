/**
 * Reference token counter (JG-006).
 *
 * The response guarantee of the specification (section 8.2) is `count(rendered
 * payload) <= max_context_tokens` *for a declared counter*. This module pins that
 * counter. It is deliberately dependency-free and local: the specification requires
 * a reproducible local measure, the ordinary test suite runs offline, and no vendor
 * tokenizer package was pinnable under that constraint. See
 * docs/reports/jg-006-response-counter.md for the recorded comparison and limits.
 *
 * What the counter is NOT: it is not a provider billing tokenizer, not Codex's
 * internal accounting, and not a claim about transport framing. Those numbers belong
 * to their owners; this one is ours and is the only one the contract promises.
 */
import type { ResponseTokenCounter } from '../search-response.ts';

/** Identifier written into `report.response_budget.counter` and into cache identity. */
export const REFERENCE_COUNTER_ID = 'jevgrep-reference-1';

/** Longest run of one class folded into a single reference token. */
const RUN_TOKEN_SIZE = 4;
/** Whitespace compresses less aggressively than words, so it is charged twice as fast. */
const SPACE_RUN_TOKEN_SIZE = 2;

function isWordByte(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) // 0-9
    || (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || code === 0x5f; // _
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  return codePoint < 0x10000 ? 3 : 4;
}

function runTokens(runLength: number, runSize: number): number {
  return Math.ceil(runLength / runSize);
}

/**
 * Count reference tokens in an arbitrary valid UTF-8 string.
 *
 * Classes: word runs (ASCII alphanumeric and `_`) and space runs fold at a fixed
 * rate, every other ASCII character is one token, and a non-ASCII code point costs
 * one token per two UTF-8 bytes. The classes never merge, which gives the property
 * the budget loop of JG-020 relies on: deleting any substring cannot increase the
 * count, because two neighbouring runs of one class can only fold together.
 */
export function countReferenceTokens(text: string): number {
  let tokens = 0;
  let wordRun = 0;
  let spaceRun = 0;

  const flush = (): void => {
    if (wordRun > 0) {
      tokens += runTokens(wordRun, RUN_TOKEN_SIZE);
      wordRun = 0;
    }
    if (spaceRun > 0) {
      tokens += runTokens(spaceRun, SPACE_RUN_TOKEN_SIZE);
      spaceRun = 0;
    }
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isWordByte(codePoint)) {
      if (spaceRun > 0) {
        flush();
      }
      wordRun += 1;
      continue;
    }
    if (codePoint === 0x20) {
      if (wordRun > 0) {
        flush();
      }
      spaceRun += 1;
      continue;
    }
    flush();
    tokens += codePoint < 0x80 ? 1 : runTokens(utf8Length(codePoint), SPACE_RUN_TOKEN_SIZE);
  }
  flush();
  return tokens;
}

/** The pinned counter handed to the renderer, the chunker and the CLI. */
export const referenceCounter: ResponseTokenCounter = Object.freeze({
  id: REFERENCE_COUNTER_ID,
  count: countReferenceTokens,
});
