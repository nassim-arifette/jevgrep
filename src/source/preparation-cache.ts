/**
 * Content-verified preparation cache.
 *
 * Every search still inventories, reads and hashes each eligible file; the cache only
 * replaces work that is a pure function of those exact bytes and of versioned code:
 * the content-scanning verdict, per-line reference tokens and fragment boundaries.
 * Fragment text is always re-sliced from the bytes just read, so a cached boundary
 * can never return text other than what the hash identifies.
 *
 * Invalidation domains are separate keys of one entry per content hash:
 * - `scan`: binary/encoding/blank/credential verdict, keyed by `SCANNER_VERSION`;
 * - `tokens`: per-line counts, keyed by the reference counter;
 * - `chunks`: boundaries and fragment token counts, keyed by chunker version, window
 *   limits and counter.
 * Eligibility (ignore rules, deny globs, authorization, size limits) is never cached:
 * the inventory runs on every search, so a rule change needs no invalidation and
 * cannot resurrect an excluded file. Criterion, model and query changes belong to the
 * score cache and never touch preparation. Entries depend on one file's bytes only;
 * there are no cross-file derived facts to track.
 *
 * Nothing persisted contains source text: an entry holds hashes, line numbers,
 * counts, labels and a verdict name. A malformed entry is a miss that is rebuilt;
 * local storage failures disable persistence for the operation, never the search.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDirectory, isMissing } from '../local-directory.ts';
import { REFERENCE_COUNTER_ID } from '../response/token-counter.ts';
import type { ChunkResult, PreparedFragment, WindowLimits } from './chunker.ts';
import type { SourceSnapshot } from './snapshot.ts';

export const PREPARATION_CACHE_SCHEMA_VERSION = 1;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 50_000;

export type ScanVerdict = 'ok' | 'binary' | 'unsupported_encoding' | 'empty' | 'whitespace_only' | 'credential_pattern';

/** Fragment reference: start line, end line, token count and, for syntax ranges, the label. */
type FragmentRef = readonly [number, number, number, (string | null)?];

type ChunkRecord =
  | {
    readonly kind: 'fragments'; readonly strategy: 'syntax' | 'line-window'; readonly fallback: 'parse_failure' | null;
    readonly chunker: string; readonly classification: 'line-window' | 'syntax-range'; readonly fragments: readonly FragmentRef[];
  }
  | { readonly kind: 'unsupported-long-line'; readonly line: number; readonly byteCount: number; readonly tokenCount: number | null };

export type PreparationEntry = {
  readonly schema_version: number;
  readonly sha256: string;
  readonly byte_length: number;
  scan: { readonly version: string; readonly verdict: ScanVerdict; readonly detail: string | null } | null;
  tokens: { readonly counter: string; readonly lines: string } | null;
  chunks: Record<string, ChunkRecord>;
};

export type PreparationCacheStats = { hits: number; misses: number; writes: number; corrupt: number; failures: number; evicted: number };

export type PreparationCacheOptions = {
  /** Persistent location outside the repository; null keeps the cache in memory only. */
  readonly directory: string | null;
  readonly enabled: boolean;
  readonly maxBytes: number;
};

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const VERDICTS: ReadonlySet<string> = new Set(['ok', 'binary', 'unsupported_encoding', 'empty', 'whitespace_only', 'credential_pattern']);

function isChunkRecord(value: unknown): value is ChunkRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'unsupported-long-line') {
    return isLine(record['line']) && isCount(record['byteCount']) && (record['tokenCount'] === null || isCount(record['tokenCount']));
  }
  return record['kind'] === 'fragments'
    && (record['strategy'] === 'syntax' || record['strategy'] === 'line-window')
    && (record['fallback'] === null || record['fallback'] === 'parse_failure')
    && typeof record['chunker'] === 'string'
    && (record['classification'] === 'line-window' || record['classification'] === 'syntax-range')
    && Array.isArray(record['fragments'])
    && (record['fragments'] as unknown[]).every((ref) => Array.isArray(ref) && (ref.length === 3 || ref.length === 4)
      && isLine(ref[0]) && isLine(ref[1]) && (ref[0] as number) <= (ref[1] as number) && isCount(ref[2])
      && (ref.length === 3 || ref[3] === null || typeof ref[3] === 'string'));
}

export function isPreparationEntry(value: unknown, sha256: string, byteLength: number): value is PreparationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const scan = entry['scan'] as Record<string, unknown> | null | undefined;
  const tokens = entry['tokens'] as Record<string, unknown> | null | undefined;
  const chunks = entry['chunks'];
  return entry['schema_version'] === PREPARATION_CACHE_SCHEMA_VERSION
    && entry['sha256'] === sha256 && entry['byte_length'] === byteLength
    && (scan === null || (typeof scan === 'object' && typeof scan['version'] === 'string'
      && typeof scan['verdict'] === 'string' && VERDICTS.has(scan['verdict'])
      && (scan['detail'] === null || typeof scan['detail'] === 'string')))
    && (tokens === null || (typeof tokens === 'object' && typeof tokens['counter'] === 'string'
      && typeof tokens['lines'] === 'string' && Buffer.from(tokens['lines'], 'base64').length % 4 === 0))
    && typeof chunks === 'object' && chunks !== null && !Array.isArray(chunks)
    && Object.values(chunks).every(isChunkRecord);
}

/** Key of one chunking result: which code split the file, under which limits and counter. */
export function chunkKey(chunkerIdentity: string, limits: WindowLimits): string {
  return createHash('sha256').update(JSON.stringify([chunkerIdentity, limits, REFERENCE_COUNTER_ID])).digest('hex').slice(0, 32);
}

export function encodeLineTokens(values: Int32Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

export function decodeLineTokens(encoded: string): Int32Array | undefined {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length % 4 !== 0) return undefined;
  const values = new Int32Array(bytes.length / 4);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readInt32LE(index * 4);
  return values.every((value) => value >= -1) ? values : undefined;
}

/** Compact, text-free form of a chunk result. */
export function recordOf(result: ChunkResult): ChunkRecord {
  if (result.kind === 'unsupported-long-line') {
    return { kind: result.kind, line: result.line, byteCount: result.byteCount, tokenCount: result.tokenCount };
  }
  const first = result.fragments[0];
  return {
    kind: 'fragments', strategy: result.strategy, fallback: result.fallback,
    chunker: first?.chunker ?? '', classification: first?.classification ?? 'line-window',
    fragments: result.fragments.map((fragment): FragmentRef => fragment.classification === 'syntax-range'
      ? [fragment.startLine, fragment.endLine, fragment.tokenCount, fragment.label ?? null]
      : [fragment.startLine, fragment.endLine, fragment.tokenCount]),
  };
}

/** True when every fragment of a result shares one chunker and classification. */
export function isRecordable(result: ChunkResult): boolean {
  if (result.kind === 'unsupported-long-line') return true;
  const first = result.fragments[0];
  return result.fragments.every((fragment) => fragment.chunker === first?.chunker && fragment.classification === first.classification);
}

/**
 * Rebuild fragments from boundaries by slicing the verified snapshot. Returns null when
 * a reference no longer fits the file, which then counts as a corrupt entry.
 */
export function resultOf(record: ChunkRecord, snapshot: SourceSnapshot): ChunkResult | null {
  if (record.kind === 'unsupported-long-line') {
    return record.line <= snapshot.lineCount
      ? { kind: record.kind, line: record.line, reason: 'unsupported_long_line', byteCount: record.byteCount, tokenCount: record.tokenCount }
      : null;
  }
  const fragments: PreparedFragment[] = [];
  for (const [startLine, endLine, tokenCount, label] of record.fragments) {
    if (endLine > snapshot.lineCount) return null;
    const slice = snapshot.sliceLines(startLine, endLine);
    if (slice.byteLength > 0 ? tokenCount < 1 || tokenCount > slice.byteLength : tokenCount !== 0) return null;
    fragments.push({
      id: `${snapshot.relativePath}#L${String(startLine)}-L${String(endLine)}`,
      path: snapshot.relativePath, sha256: snapshot.sha256, startLine, endLine,
      byteStart: slice.startByte, byteEnd: slice.endByte, text: slice.text,
      byteCount: slice.byteLength, tokenCount, chunker: record.chunker, classification: record.classification,
      ...(record.classification === 'syntax-range' ? { label: label ?? null } : {}),
    });
  }
  return { kind: 'fragments', strategy: record.strategy, fallback: record.fallback, fragments };
}

/** Two tiers: an in-process map and, optionally, bounded per-entry files. */
export class PreparationCache {
  readonly stats: PreparationCacheStats = { hits: 0, misses: 0, writes: 0, corrupt: 0, failures: 0, evicted: 0 };
  readonly #options: PreparationCacheOptions;
  readonly #storage: LocalDirectory | null;
  readonly #memory = new Map<string, PreparationEntry>();
  readonly #dirty = new Map<string, PreparationEntry>();

  constructor(options: PreparationCacheOptions) {
    this.#options = options;
    let storage: LocalDirectory | null = null;
    if (options.enabled && options.directory !== null) {
      try { storage = new LocalDirectory(options.directory); } catch { this.stats.failures += 1; }
    }
    this.#storage = storage;
  }

  get enabled(): boolean { return this.#options.enabled; }

  #name(sha256: string): string { return `${sha256.slice(0, 2)}/${sha256}.json`; }

  /** Entry for exact content, or a fresh empty one. The caller mutates it and calls `update`. */
  get(sha256: string, byteLength: number): PreparationEntry {
    const empty = (): PreparationEntry => ({
      schema_version: PREPARATION_CACHE_SCHEMA_VERSION, sha256, byte_length: byteLength, scan: null, tokens: null, chunks: {},
    });
    if (!this.enabled || !/^[a-f0-9]{64}$/.test(sha256)) return empty();
    const remembered = this.#memory.get(sha256);
    if (remembered !== undefined && remembered.byte_length === byteLength) {
      this.#memory.delete(sha256);
      this.#memory.set(sha256, remembered);
      this.stats.hits += 1;
      return remembered;
    }
    if (this.#storage !== null) {
      const name = this.#name(sha256);
      try {
        const parsed: unknown = JSON.parse(this.#storage.read(name, MAX_ENTRY_BYTES).toString('utf8'));
        if (isPreparationEntry(parsed, sha256, byteLength)) {
          this.#remember(parsed);
          this.stats.hits += 1;
          return parsed;
        }
        this.stats.corrupt += 1;
        this.#discard(name);
      } catch (cause) {
        if (cause instanceof SyntaxError) { this.stats.corrupt += 1; this.#discard(name); }
        else if (!isMissing(cause)) this.stats.failures += 1;
      }
    }
    this.stats.misses += 1;
    return empty();
  }

  /** Record a changed entry in memory; `flush` persists it. */
  update(entry: PreparationEntry): void {
    if (!this.enabled) return;
    this.#remember(entry);
    this.#dirty.set(entry.sha256, entry);
  }

  /** Forget an entry whose references did not fit its verified content. */
  reject(sha256: string): void {
    this.stats.corrupt += 1;
    this.#memory.delete(sha256);
    this.#dirty.delete(sha256);
    if (this.#storage !== null) this.#discard(this.#name(sha256));
  }

  #remember(entry: PreparationEntry): void {
    this.#memory.delete(entry.sha256);
    this.#memory.set(entry.sha256, entry);
    while (this.#memory.size > MAX_MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
  }

  /** Persist changed entries under one writer lock, then enforce the size bound. */
  flush(): number {
    if (this.#storage === null || this.#dirty.size === 0) { this.#dirty.clear(); return 0; }
    const pending = [...this.#dirty.values()];
    let written = 0;
    try {
      this.#storage.withLock(() => {
        for (const entry of pending) {
          const raw = `${JSON.stringify(entry)}\n`;
          if (Buffer.byteLength(raw) > Math.min(MAX_ENTRY_BYTES, this.#options.maxBytes)) continue;
          this.#storage!.write(this.#name(entry.sha256), raw);
          written += 1;
        }
        this.#evict();
      });
      this.#dirty.clear();
    } catch { this.stats.failures += 1; }
    this.stats.writes += written;
    return written;
  }

  /** Oldest-first eviction by modification time; only valid entry names are removed. */
  #evict(): void {
    const storage = this.#storage!;
    const root = storage.root();
    const entries: { name: string; size: number; mtime: number }[] = [];
    for (const shard of root.readDirectory('.')) {
      if (!/^[a-f0-9]{2}$/.test(shard.name)) continue;
      for (const file of root.readDirectory(shard.name)) {
        if (!/^[a-f0-9]{64}\.json$/.test(file.name) || !file.name.startsWith(shard.name)) continue;
        const name = `${shard.name}/${file.name}`;
        try {
          const stat = lstatSync(join(root.path, name));
          if (stat.isFile()) entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
        } catch (cause) { if (!isMissing(cause)) this.stats.failures += 1; }
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (total <= this.#options.maxBytes) break;
      if (this.#discard(entry.name)) { total -= entry.size; this.stats.evicted += 1; }
    }
  }

  #discard(name: string): boolean {
    try { return this.#storage!.remove(name); } catch { this.stats.failures += 1; return false; }
  }
}
