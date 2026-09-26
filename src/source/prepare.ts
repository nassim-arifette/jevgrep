/**
 * Preparation: from an inventory to snapshots and fragments (JG-010, JG-011, JG-012, JG-015).
 *
 * This is the first stage allowed to read bytes, so it is also the stage that applies
 * the content-based exclusions of specification section 5.2: invalid encodings,
 * binary content, empty and whitespace-only files, credential patterns and lines no
 * legal fragment can hold. A credential match quarantines the whole file for this
 * search; the text is never rewritten to "clean" it, because a redacted file would
 * still be a file whose contents left the machine.
 *
 * Preparation is cancellable and reports exactly what it could not finish: an
 * unreadable eligible file or an interrupted walk means the scan can never claim full
 * coverage (requirement R8).
 */
import { createHash } from 'node:crypto';
import { REFERENCE_COUNTER_ID, countReferenceTokens } from '../response/token-counter.ts';
import { countProfile, measureSync } from '../profiling.ts';
import { AuthorizedRoot, UnauthorizedPathError } from './authorization.ts';
import { DEFAULT_WINDOW_LIMITS, chunkSnapshot, chunkerVersionFor } from './chunker.ts';
import type { ChunkResult, PreparedFragment, WindowLimits } from './chunker.ts';
import { inventoryScope } from './inventory.ts';
import type { InventoryOptions, InventoryResult } from './inventory.ts';
import {
  chunkKey, decodeLineTokens, encodeLineTokens, isRecordable, recordOf, resultOf,
  type PreparationCache, type PreparationEntry, type ScanVerdict,
} from './preparation-cache.ts';
import { SnapshotError, createSnapshot, hashBytes } from './snapshot.ts';
import type { SourceSnapshot } from './snapshot.ts';

/**
 * Patterns that quarantine a whole file before any dispatch.
 *
 * This reduces accidental disclosure; it cannot prove that arbitrary source text
 * contains no secret. The operator's disclosure authorization still has to cover the
 * eligible code (specification section 5.2).
 */
export const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'stripe_secret_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'assigned_secret', pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i },
]);

/**
 * Identity of every content check whose verdict the preparation cache may reuse:
 * the NUL and UTF-8 rules, the blank rule and each credential pattern.
 */
export const SCANNER_VERSION = createHash('sha256').update(JSON.stringify([
  'nul-utf8-fatal-bom-kept-1', 'trim-blank-1',
  CREDENTIAL_PATTERNS.map(({ name, pattern }) => [name, pattern.source, pattern.flags]),
])).digest('hex').slice(0, 16);

/** Name of the first credential pattern found in a text, or null. */
export function findCredentialPattern(text: string): string | null {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}

export type PreparedFile = {
  readonly snapshot: SourceSnapshot;
  readonly fragments: readonly PreparedFragment[];
  readonly strategy: 'syntax' | 'line-window';
  readonly parseFallback: boolean;
};

export type PreparationExclusion = {
  readonly relativePath: string;
  readonly reason: string;
  /** Extra local detail for diagnostics, for example the credential pattern's name. */
  readonly detail?: string;
};

export type PreparedScope = {
  readonly inventory: InventoryResult;
  readonly files: readonly PreparedFile[];
  readonly fragments: readonly PreparedFragment[];
  /** Content-stage exclusions, added to the inventory's own counts. */
  readonly excluded: readonly PreparationExclusion[];
  readonly unreadable: number;
  readonly preparedBytes: number;
  /** False when inventory or preparation stopped early; no full-coverage claim is possible. */
  readonly complete: boolean;
  readonly parseFallbacks: number;
};

export type PreparationLimits = {
  /** Optional aggregate caps; `null` keeps them disabled, which is the default. */
  readonly preparedSourceBytes: number | null;
  readonly candidateFiles: number | null;
  readonly fragments: number | null;
};

export const NO_PREPARATION_LIMITS: PreparationLimits = Object.freeze({
  preparedSourceBytes: null, candidateFiles: null, fragments: null,
});

export type PrepareOptions = {
  readonly inventory: InventoryOptions;
  readonly windowLimits?: WindowLimits;
  readonly limits?: PreparationLimits;
  /** Interrupts preparation between files; the result is then explicitly incomplete. */
  readonly shouldStop?: () => boolean;
  /** Reuses content-derived work for byte-identical files; eligibility is always recomputed. */
  readonly cache?: PreparationCache;
};

/**
 * Inventory the scope and prepare every eligible file.
 *
 * The order of the returned fragments is deterministic: normalized path order, then
 * increasing start line, which is also the order a partial scan consumes.
 */
export function prepareScope(
  root: AuthorizedRoot,
  scope: readonly string[],
  options: PrepareOptions,
): PreparedScope {
  const inventory = measureSync('inventory', () => inventoryScope(root, scope, options.inventory));
  const limits = options.limits ?? NO_PREPARATION_LIMITS;

  const files: PreparedFile[] = [];
  const fragments: PreparedFragment[] = [];
  const excluded: PreparationExclusion[] = [];
  let unreadable = 0;
  let preparedBytes = 0;
  let parseFallbacks = 0;
  let complete = inventory.complete;

  for (const entry of inventory.files) {
    if (options.shouldStop?.() === true) {
      complete = false;
      break;
    }
    if (limits.candidateFiles !== null && files.length >= limits.candidateFiles) {
      complete = false;
      break;
    }

    let bytes;
    try {
      bytes = measureSync('source_read', () => root.readFileBytes(entry.absolutePath, options.inventory.maxFileBytes));
    } catch (cause) {
      if (cause instanceof UnauthorizedPathError) {
        if (cause.refusal === 'changed' || cause.refusal === 'unavailable' || cause.refusal === 'missing') {
          unreadable += 1;
          complete = false;
          continue;
        }
        excluded.push({ relativePath: entry.relativePath,
          reason: cause.refusal === 'link' ? 'link' : cause.refusal === 'too_large' ? 'file_too_large' : 'not_regular_file' });
        continue;
      }
      unreadable += 1;
      complete = false;
      continue;
    }

    if (limits.preparedSourceBytes !== null && preparedBytes + bytes.length > limits.preparedSourceBytes) {
      complete = false;
      break;
    }

    const cache = options.cache?.enabled === true ? options.cache : undefined;
    const sha256 = cache === undefined ? undefined : measureSync('hash', () => hashBytes(bytes));
    const cached = cache === undefined || sha256 === undefined ? undefined : measureSync('cache_lookup', () => cache.get(sha256, bytes.length));
    const windowLimits = options.windowLimits ?? DEFAULT_WINDOW_LIMITS;
    let outcome = prepareContent(entry.relativePath, entry.absolutePath, bytes, windowLimits, cached, sha256);
    if (cache !== undefined && cached !== undefined && sha256 !== undefined) {
      if (outcome.rejected) {
        // An entry that does not fit its verified bytes is dropped and rebuilt from scratch.
        cache.reject(sha256);
        const rebuilt = cache.get(sha256, bytes.length);
        outcome = prepareContent(entry.relativePath, entry.absolutePath, bytes, windowLimits, rebuilt, sha256);
        if (outcome.changed && !outcome.rejected) cache.update(rebuilt);
      } else if (outcome.changed) {
        cache.update(cached);
      }
    }
    if (outcome.kind === 'excluded') {
      excluded.push({ relativePath: entry.relativePath, reason: outcome.reason, ...(outcome.detail === null ? {} : { detail: outcome.detail }) });
      continue;
    }
    const { snapshot, chunked } = outcome;
    if (chunked.kind === 'unsupported-long-line') {
      excluded.push({
        relativePath: entry.relativePath, reason: 'unsupported_long_line',
        detail: `line ${String(chunked.line)}`,
      });
      continue;
    }
    if (limits.fragments !== null && fragments.length + chunked.fragments.length > limits.fragments) {
      complete = false;
      break;
    }

    if (chunked.fallback === 'parse_failure') {
      parseFallbacks += 1;
    }
    files.push({
      snapshot, fragments: chunked.fragments, strategy: chunked.strategy,
      parseFallback: chunked.fallback === 'parse_failure',
    });
    fragments.push(...chunked.fragments);
    preparedBytes += bytes.length;
  }

  if (options.cache?.enabled === true) {
    const cache = options.cache;
    measureSync('cache_write', () => cache.flush());
  }

  return {
    inventory, files, fragments, excluded, unreadable, preparedBytes,
    complete: complete && inventory.complete, parseFallbacks,
  };
}

type ContentOutcome = { readonly changed: boolean; readonly rejected: boolean } & (
  | { readonly kind: 'excluded'; readonly reason: Exclude<ScanVerdict, 'ok'>; readonly detail: string | null }
  | { readonly kind: 'chunked'; readonly snapshot: SourceSnapshot; readonly chunked: ChunkResult }
);

/**
 * Content checks and chunking of one file's bytes, in the order of section 5.2.
 *
 * With a cache entry for these exact bytes, a verdict from the current scanner is
 * reused, known line tokens seed the snapshot and boundaries from the current chunker
 * and limits are re-sliced from the bytes. Anything missing is computed and recorded
 * in the entry, so each invalidation domain is rebuilt independently.
 */
function prepareContent(
  relativePath: string,
  absolutePath: string,
  bytes: Buffer,
  windowLimits: WindowLimits,
  entry: PreparationEntry | undefined,
  sha256: string | undefined,
): ContentOutcome {
  let changed = false;
  let rejected = false;
  const scan = entry?.scan?.version === SCANNER_VERSION ? entry.scan : null;
  const exclusion = (reason: Exclude<ScanVerdict, 'ok'>, detail: string | null): ContentOutcome => {
    if (entry !== undefined && scan === null) {
      entry.scan = { version: SCANNER_VERSION, verdict: reason, detail };
      changed = true;
    }
    return { kind: 'excluded', reason, detail, changed, rejected };
  };
  if (scan !== null) {
    countProfile('preparation_cache_scan_reused');
    if (scan.verdict !== 'ok') return { kind: 'excluded', reason: scan.verdict, detail: scan.detail, changed, rejected };
  }

  const knownTokens = entry?.tokens?.counter === REFERENCE_COUNTER_ID ? decodeLineTokens(entry.tokens.lines) : undefined;
  let snapshot: SourceSnapshot;
  try {
    snapshot = measureSync('snapshot', () => createSnapshot(relativePath, absolutePath, bytes, countReferenceTokens, {
      ...(sha256 === undefined ? {} : { sha256 }), ...(knownTokens === undefined ? {} : { lineTokens: knownTokens }),
    }));
  } catch (cause) {
    if (cause instanceof SnapshotError) return exclusion(cause.refusal, null);
    throw cause;
  }
  if (entry?.tokens !== undefined && entry.tokens !== null && knownTokens?.length !== snapshot.lineCount) {
    rejected = entry.tokens.counter === REFERENCE_COUNTER_ID;
  }

  if (scan === null) {
    if (snapshot.isBlank()) return exclusion(snapshot.byteLength === 0 ? 'empty' : 'whitespace_only', null);
    const credential = measureSync('secret_scan', () => findCredentialPattern(snapshot.text));
    if (credential !== null) return exclusion('credential_pattern', credential);
    if (entry !== undefined) {
      entry.scan = { version: SCANNER_VERSION, verdict: 'ok', detail: null };
      changed = true;
    }
  }

  const key = chunkKey(chunkerVersionFor(relativePath), windowLimits);
  const record = entry?.chunks[key];
  let chunked = record === undefined || rejected ? null : resultOf(record, snapshot);
  if (record !== undefined && chunked === null) rejected = true;
  if (chunked !== null) {
    countProfile('preparation_cache_chunks_reused');
  } else {
    chunked = measureSync('chunking', () => chunkSnapshot(snapshot, windowLimits));
    if (entry !== undefined && isRecordable(chunked)) {
      entry.chunks[key] = recordOf(chunked);
      changed = true;
    }
  }
  if (entry !== undefined) {
    const lines = encodeLineTokens(snapshot.measuredLineTokens());
    if (entry.tokens?.counter !== REFERENCE_COUNTER_ID || entry.tokens.lines !== lines) {
      entry.tokens = { counter: REFERENCE_COUNTER_ID, lines };
      changed = true;
    }
  }
  return { kind: 'chunked', snapshot, chunked, changed, rejected };
}

/** Total exclusions by contract reason, combining both stages. */
export function exclusionCounts(prepared: PreparedScope): Record<string, number> {
  const counts: Record<string, number> = { ...prepared.inventory.excludedByReason };
  for (const item of prepared.excluded) {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}
