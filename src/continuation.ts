import { createHash } from 'node:crypto';

/**
 * Continuation of a partial search (roadmap section 10).
 *
 * The score cache already preserves completed evaluations, so a continued search
 * evaluates only fragments that were never scored. The token carries what the cache
 * cannot: which evidence the caller has already received, so the next response
 * delivers new evidence instead of repeating it. Each delivered fragment is recorded
 * as a digest of its location and file content; an edited file therefore becomes
 * eligible again. The token is bound to the query, scope and evaluation policy and is
 * refused when any of them changes.
 */
export const CONTINUATION_PREFIX = 'jgc1.';
const DIGEST_BYTES = 8;
/** Bounds the token, which counts against the response budget. */
export const MAX_DELIVERED_FRAGMENTS = 256;
export const MAX_CONTINUATION_TOKEN_LENGTH =
  CONTINUATION_PREFIX.length + Math.ceil(((MAX_DELIVERED_FRAGMENTS + 1) * DIGEST_BYTES * 4) / 3);

export type ContinuationBinding = {
  readonly query: string;
  readonly scope: readonly string[];
  readonly adapter: string;
  readonly endpoint: string;
  readonly model: string;
  readonly threshold: number;
  readonly selectionPolicy: string;
  readonly versions: Readonly<Record<string, string>>;
};

export type ContinuationState = {
  readonly binding: Buffer;
  readonly delivered: ReadonlySet<string>;
};

export class ContinuationError extends Error {
  constructor(message: string) {
    super(`continuation refused: ${message}`);
    this.name = 'ContinuationError';
  }
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest().subarray(0, DIGEST_BYTES);
}

export function bindingDigest(binding: ContinuationBinding): Buffer {
  const versions = Object.keys(binding.versions).sort().map((key) => [key, binding.versions[key]]);
  return digest(JSON.stringify([binding.query, [...binding.scope], binding.adapter, binding.endpoint,
    binding.model, binding.threshold, binding.selectionPolicy, versions]));
}

/** Identity of one delivered fragment: its location and the exact file content it came from. */
export function deliveredKey(fragment: { readonly id: string; readonly sha256: string }): string {
  return digest(`${fragment.id}\u0000${fragment.sha256}`).toString('hex');
}

export function decodeContinuation(token: string, expected: Buffer): ContinuationState {
  if (!token.startsWith(CONTINUATION_PREFIX) || token.length > MAX_CONTINUATION_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]*$/.test(token.slice(CONTINUATION_PREFIX.length))) {
    throw new ContinuationError('malformed token');
  }
  const bytes = Buffer.from(token.slice(CONTINUATION_PREFIX.length), 'base64url');
  if (bytes.length < DIGEST_BYTES || bytes.length % DIGEST_BYTES !== 0) {
    throw new ContinuationError('malformed token');
  }
  if (!bytes.subarray(0, DIGEST_BYTES).equals(expected)) {
    throw new ContinuationError('the query, scope, provider or evaluation policy changed; start a new search');
  }
  const delivered = new Set<string>();
  for (let offset = DIGEST_BYTES; offset < bytes.length; offset += DIGEST_BYTES) {
    delivered.add(bytes.subarray(offset, offset + DIGEST_BYTES).toString('hex'));
  }
  return { binding: expected, delivered };
}

/** A token recording every delivered key, or null when it would exceed its bound. */
export function encodeContinuation(binding: Buffer, delivered: ReadonlySet<string>): string | null {
  if (delivered.size > MAX_DELIVERED_FRAGMENTS) return null;
  const keys = [...delivered].sort();
  return CONTINUATION_PREFIX + Buffer.concat([binding, ...keys.map((key) => Buffer.from(key, 'hex'))]).toString('base64url');
}
