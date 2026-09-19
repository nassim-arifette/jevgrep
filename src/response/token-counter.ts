/**
 * Pinned local response tokenizer (JG-006, specification 8.2).
 * The complete serialized payload is measured; this is not provider/Codex billing.
 * Vocabulary data is bundled in the installed package and never fetched at runtime.
 */
import { get_encoding, type Tiktoken } from 'tiktoken';
import type { ResponseTokenCounter } from '../search-response.ts';

export const REFERENCE_COUNTER_ID = 'tiktoken@1.0.22/cl100k_base';
let encoding: Tiktoken | undefined;

/** BPE counts are not monotone under deletion: always remeasure the final payload. */
export function countReferenceTokens(text: string): number {
  encoding ??= get_encoding('cl100k_base');
  // Source text may literally contain a special-token marker; treat it as ordinary text.
  return encoding.encode(text, [], []).length;
}

export const referenceCounter: ResponseTokenCounter = Object.freeze({
  id: REFERENCE_COUNTER_ID,
  count: countReferenceTokens,
});
