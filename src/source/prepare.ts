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
import { performance } from 'node:perf_hooks';
import { REFERENCE_COUNTER_ID, countReferenceTokens } from '../response/token-counter.ts';
import { countProfile, measureSteps, measureSync } from '../profiling.ts';
import { AuthorizedRoot, UnauthorizedPathError } from './authorization.ts';
import { DEFAULT_CHUNKER, DEFAULT_WINDOW_LIMITS } from './chunker.ts';
import type { SnapshotChunker } from './chunker.ts';
import type { ChunkResult, PreparedFragment, WindowLimits } from './chunker.ts';
import { inventorySteps } from './inventory.ts';
import type { InventoryOptions, InventoryResult } from './inventory.ts';
import {
  PREPARATION_CACHE_SCHEMA_VERSION, chunkKey, decodeLineTokens, encodeLineTokens, isRecordable, recordOf, resultOf,
  type PreparationCache, type PreparationEntry, type ScanVerdict,
} from './preparation-cache.ts';
import { PREPARE_POOL_MIN_BYTES, type PoolLease, type PoolMode, type PoolResult, acquirePool } from './prepare-pool.ts';
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
  /** Benchmark seam for chunking experiments; production always uses the default chunker. */
  readonly chunker?: SnapshotChunker;
  readonly limits?: PreparationLimits;
  /** Interrupts preparation between files; the result is then explicitly incomplete. */
  readonly shouldStop?: () => boolean;
  /** Reuses content-derived work for byte-identical files; eligibility is always recomputed. */
  readonly cache?: PreparationCache;
  /** Order in which inventoried files are prepared; only matters when a limit stops preparation early. */
  readonly fileOrder?: <T extends { readonly relativePath: string }>(files: readonly T[]) => readonly T[];
  /**
   * Worker threads that scan and chunk files in parallel; 0 keeps everything on the
   * calling thread. Default: the other cores. Results are identical either way.
   */
  readonly threads?: number;
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
  const steps = preparationSteps(root, scope, options, 'sync');
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/** Longest stretch of preparation work between two returns to the event loop. */
export const PREPARATION_SLICE_MS = 10;

/**
 * `prepareScope` that returns to the event loop at least every `sliceMs` of work.
 *
 * Preparation is synchronous CPU and file work; without yielding, a stdio MCP server
 * cannot read a cancellation, a ping or a second request until it ends. Yields happen
 * between files, so the longest single file bounds the pause; with a worker pool the
 * files are prepared off this thread and awaited, so the pause is shorter still. The
 * result is identical to `prepareScope`.
 */
export async function prepareScopeCooperatively(
  root: AuthorizedRoot,
  scope: readonly string[],
  options: PrepareOptions,
  sliceMs: number = PREPARATION_SLICE_MS,
): Promise<PreparedScope> {
  const steps = preparationSteps(root, scope, options, 'async');
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    if (step.value !== undefined) {
      await step.value;
      sliceStart = performance.now();
      continue;
    }
    if (performance.now() - sliceStart >= sliceMs) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      sliceStart = performance.now();
    }
  }
}

/**
 * The preparation loop, suspended before each file so a caller can interleave other
 * work. With an async pool it also yields the promise of a worker result it needs
 * next, which the cooperative caller awaits; the synchronous caller never sees one.
 */
function* preparationSteps(
  root: AuthorizedRoot,
  scope: readonly string[],
  options: PrepareOptions,
  poolMode: PoolMode,
): Generator<Promise<unknown> | undefined, PreparedScope, undefined> {
  const inventory = yield* measureSteps('inventory', inventorySteps(root, scope, options.inventory));
  const limits = options.limits ?? NO_PREPARATION_LIMITS;

  const files: PreparedFile[] = [];
  const fragments: PreparedFragment[] = [];
  const excluded: PreparationExclusion[] = [];
  let unreadable = 0;
  let preparedBytes = 0;
  let parseFallbacks = 0;
  let complete = inventory.complete;

  const ordered = options.fileOrder?.(inventory.files) ?? inventory.files;
  const lease = openPool(ordered, options, poolMode);
  const pool = lease?.pool ?? null;
  // Files are read in order and handed to the pool ahead of their turn; limits, stops
  // and exclusions are still applied in order, when each file's turn comes.
  const ahead: { entry: InventoryResult['files'][number]; read: EntryRead; job: PoolJob | null }[] = [];
  let cursor = 0;
  const readAhead = (): void => {
    const depth = pool === null ? 1 : pool.size * 2;
    while (ahead.length < depth && cursor < ordered.length) {
      const entry = ordered[cursor]!;
      cursor += 1;
      const read = readEntry(root, entry.absolutePath, options.inventory.maxFileBytes);
      const job = pool !== null && read.kind === 'read' ? submitToPool(pool, entry, read.bytes, options) : null;
      ahead.push({ entry, read, job });
    }
  };

  try {
    for (;;) {
      readAhead();
      const next = ahead.shift();
      if (next === undefined) break;
      yield;
      if (options.shouldStop?.() === true) {
        complete = false;
        break;
      }
      if (limits.candidateFiles !== null && files.length >= limits.candidateFiles) {
        complete = false;
        break;
      }
      const { entry, read } = next;
      if (read.kind === 'unreadable') {
        unreadable += 1;
        complete = false;
        continue;
      }
      if (read.kind === 'excluded') {
        excluded.push({ relativePath: entry.relativePath, reason: read.reason });
        continue;
      }
      const { bytes } = read;

      if (limits.preparedSourceBytes !== null && preparedBytes + bytes.length > limits.preparedSourceBytes) {
        complete = false;
        break;
      }

      let computed: PoolResult | undefined;
      if (next.job !== null && pool !== null) {
        if (pool.mode === 'async') {
          const waited = pool.wait(next.job.ticket).then((result) => { settled.set(waited, result); return result; });
          yield waited;
          computed = awaited(waited);
        } else {
          computed = pool.collect(next.job.ticket);
        }
      }
      const outcome = prepareWithCache(entry.relativePath, entry.absolutePath, bytes, options,
        computed !== undefined && 'entry' in computed && next.job !== null
          ? { entry: computed.entry, sha256: next.job.sha256, cached: next.job.cached } : undefined);
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
  } finally {
    for (const entry of ahead) if (entry.job !== null) pool?.forget(entry.job.ticket);
    lease?.release();
  }

  if (options.cache?.enabled === true) {
    const cache = options.cache;
    measureSync('cache_write', () => cache.flush());
  }

  if (options.fileOrder !== undefined) {
    // Results keep inventory order whatever order the files were read in.
    const rank = new Map(inventory.files.map((entry, index) => [entry.relativePath, index]));
    const of = (path: string): number => rank.get(path) ?? Infinity;
    files.sort((left, right) => of(left.snapshot.relativePath) - of(right.snapshot.relativePath));
    const ordered = files.flatMap((file) => file.fragments);
    fragments.splice(0, fragments.length, ...ordered);
  }

  return {
    inventory, files, fragments, excluded, unreadable, preparedBytes,
    complete: complete && inventory.complete, parseFallbacks,
  };
}

type EntryRead =
  | { readonly kind: 'read'; readonly bytes: Buffer }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'excluded'; readonly reason: 'link' | 'file_too_large' | 'not_regular_file' };

/** A vanished or changed file is unreadable (coverage is lost); a refused one is excluded. */
function readEntry(root: AuthorizedRoot, absolutePath: string, maxFileBytes: number): EntryRead {
  try {
    return { kind: 'read', bytes: measureSync('source_read', () => root.readFileBytes(absolutePath, maxFileBytes)) };
  } catch (cause) {
    if (!(cause instanceof UnauthorizedPathError)) return { kind: 'unreadable' };
    if (cause.refusal === 'changed' || cause.refusal === 'unavailable' || cause.refusal === 'missing') return { kind: 'unreadable' };
    return { kind: 'excluded',
      reason: cause.refusal === 'link' ? 'link' : cause.refusal === 'too_large' ? 'file_too_large' : 'not_regular_file' };
  }
}

/**
 * A yielded promise is awaited by the cooperative caller before the generator resumes,
 * so its value is already settled here; it is read synchronously from a side channel.
 */
const settled = new WeakMap<Promise<unknown>, unknown>();
function awaited<T>(promise: Promise<T>): T {
  const value = settled.get(promise);
  if (value === undefined) throw new Error('a pool result was resumed before it settled');
  settled.delete(promise);
  return value as T;
}

/** A pool when the scope is large enough and the production chunker is in use. */
function openPool(files: readonly { readonly sizeBytes: number }[], options: PrepareOptions, mode: PoolMode): PoolLease | null {
  if (options.chunker !== undefined && options.chunker !== DEFAULT_CHUNKER) return null;
  if (files.length < 2) return null;
  const bytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (options.threads === undefined && bytes < PREPARE_POOL_MIN_BYTES) return null;
  return acquirePool(options.threads, mode);
}

type PoolJob = { readonly ticket: number; readonly sha256: string; readonly cached: PreparationEntry | undefined };

/** Hand a file to the pool unless a cache entry already holds its chunks. */
function submitToPool(
  pool: PoolLease['pool'], entry: { readonly relativePath: string; readonly absolutePath: string }, bytes: Buffer, options: PrepareOptions,
): PoolJob | null {
  const sha256 = measureSync('hash', () => hashBytes(bytes));
  const cache = options.cache?.enabled === true ? options.cache : undefined;
  const cached = cache === undefined ? undefined : measureSync('cache_lookup', () => cache.get(sha256, bytes.length));
  if (cached !== undefined) {
    const key = chunkKey((options.chunker ?? DEFAULT_CHUNKER).identity(entry.relativePath), options.windowLimits ?? DEFAULT_WINDOW_LIMITS);
    if (cached.chunks[key] !== undefined || (cached.scan !== null && cached.scan.verdict !== 'ok' && cached.scan.version === SCANNER_VERSION)) return null;
  }
  const ticket = pool.submit({ relativePath: entry.relativePath, absolutePath: entry.absolutePath, bytes, sha256, windowLimits: options.windowLimits ?? DEFAULT_WINDOW_LIMITS });
  return { ticket, sha256, cached };
}

/**
 * The content stage of one file on its own: a fresh preparation entry holding the
 * verdict, per-line tokens and fragment boundaries for these bytes. Pool workers run it.
 */
export function prepareEntry(relativePath: string, absolutePath: string, bytes: Buffer, sha256: string, windowLimits: WindowLimits): PreparationEntry {
  const entry: PreparationEntry = { schema_version: PREPARATION_CACHE_SCHEMA_VERSION, sha256, byte_length: bytes.length, scan: null, tokens: null, chunks: {} };
  prepareContent(relativePath, absolutePath, bytes, windowLimits, DEFAULT_CHUNKER, entry, sha256);
  return entry;
}

/**
 * Chunk the bytes, reusing a verified preparation-cache entry when one exists, or the
 * entry a pool worker computed for these exact bytes.
 */
function prepareWithCache(
  relativePath: string, absolutePath: string, bytes: Buffer, options: PrepareOptions,
  computed?: { readonly entry: PreparationEntry; readonly sha256: string; readonly cached: PreparationEntry | undefined },
): ContentOutcome {
  const cache = options.cache?.enabled === true ? options.cache : undefined;
  const sha256 = computed?.sha256 ?? (cache === undefined ? undefined : measureSync('hash', () => hashBytes(bytes)));
  let cached = computed !== undefined ? computed.cached
    : cache === undefined || sha256 === undefined ? undefined : measureSync('cache_lookup', () => cache.get(sha256, bytes.length));
  let seeded = false;
  if (computed !== undefined) {
    countProfile('preparation_pool_files');
    if (cached === undefined) {
      cached = computed.entry;
    } else {
      // The worker's result seeds the cache entry, which is then recorded like any change.
      if (cached.scan === null) { cached.scan = computed.entry.scan; seeded = true; }
      if (cached.tokens === null) { cached.tokens = computed.entry.tokens; seeded = true; }
      for (const [key, record] of Object.entries(computed.entry.chunks)) {
        if (cached.chunks[key] === undefined) { cached.chunks[key] = record; seeded = true; }
      }
    }
  }
  const windowLimits = options.windowLimits ?? DEFAULT_WINDOW_LIMITS;
  const chunker = options.chunker ?? DEFAULT_CHUNKER;
  let outcome = prepareContent(relativePath, absolutePath, bytes, windowLimits, chunker, cached, sha256);
  if (computed !== undefined && cache === undefined && (outcome.rejected || outcome.changed)) {
    // A worker entry that does not reproduce from the bytes is not trusted: start over here.
    countProfile('preparation_pool_rebuilt');
    outcome = prepareContent(relativePath, absolutePath, bytes, windowLimits, chunker, undefined, sha256);
  }
  if (seeded && !outcome.rejected && cache !== undefined && cached !== undefined) cache.update(cached);
  if (cache !== undefined && cached !== undefined && sha256 !== undefined) {
    if (outcome.rejected) {
      // An entry that does not fit its verified bytes is dropped and rebuilt from scratch.
      cache.reject(sha256);
      const rebuilt = cache.get(sha256, bytes.length);
      outcome = prepareContent(relativePath, absolutePath, bytes, windowLimits, chunker, rebuilt, sha256);
      if (outcome.changed && !outcome.rejected) cache.update(rebuilt);
    } else if (outcome.changed) {
      cache.update(cached);
    }
  }
  return outcome;
}

type ContentOutcome = { readonly changed: boolean; readonly rejected: boolean } & (
  | { readonly kind: 'excluded'; readonly reason: Exclude<ScanVerdict, 'ok'>; readonly detail: string | null }
  | { readonly kind: 'chunked'; readonly snapshot: SourceSnapshot; readonly chunked: ChunkResult }
);

/**
 * Content checks and chunking of one file's bytes, in the order of section 5.2.
 *
 * With a cache entry for these exact bytes, an exclusion verdict from the current
 * scanner is reused (an `ok` verdict is always re-checked, so a cache entry can only
 * withhold content, never release it), known line tokens seed the snapshot and boundaries from the current chunker
 * and limits are re-sliced from the bytes. Anything missing is computed and recorded
 * in the entry, so each invalidation domain is rebuilt independently.
 */
function prepareContent(
  relativePath: string,
  absolutePath: string,
  bytes: Buffer,
  windowLimits: WindowLimits,
  chunker: SnapshotChunker,
  entry: PreparationEntry | undefined,
  sha256: string | undefined,
): ContentOutcome {
  let changed = false;
  let rejected = false;
  const cachedScan = entry?.scan;
  const scan = cachedScan?.version === SCANNER_VERSION && cachedScan.verdict !== 'ok'
    ? { verdict: cachedScan.verdict, detail: cachedScan.detail }
    : null;
  const exclusion = (reason: Exclude<ScanVerdict, 'ok'>, detail: string | null): ContentOutcome => {
    if (entry !== undefined && scan === null) {
      entry.scan = { version: SCANNER_VERSION, verdict: reason, detail };
      changed = true;
    }
    return { kind: 'excluded', reason, detail, changed, rejected };
  };
  if (scan !== null) {
    countProfile('preparation_cache_scan_reused');
    return { kind: 'excluded', reason: scan.verdict, detail: scan.detail, changed, rejected };
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
    if (entry !== undefined && (entry.scan?.version !== SCANNER_VERSION || entry.scan.verdict !== 'ok')) {
      entry.scan = { version: SCANNER_VERSION, verdict: 'ok', detail: null };
      changed = true;
    }
  }

  const key = chunkKey(chunker.identity(relativePath), windowLimits);
  const record = entry?.chunks[key];
  let chunked = record === undefined || rejected ? null : resultOf(record, snapshot);
  if (record !== undefined && chunked === null) rejected = true;
  if (chunked !== null) {
    countProfile('preparation_cache_chunks_reused');
  } else {
    chunked = measureSync('chunking', () => chunker.chunk(snapshot, windowLimits));
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
