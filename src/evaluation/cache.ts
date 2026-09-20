/**
 * Per-question evaluation cache (JG-018).
 *
 * The cache avoids repeating a judgment whose explicit inputs have not changed.
 * Pinned revisions use the configured TTL; known rolling aliases require an explicit
 * short TTL and may reuse a score from a previous model revision within that window.
 * Its identity therefore hashes everything the model can
 * see — the exact query, the criterion and its version, the request layout, the
 * provider endpoint, the model id and reuse policy, the transmitted path and line range,
 * the chunker version and the excerpt text itself (specification section 9).
 *
 * What deliberately does *not* belong to identity: selection threshold, response
 * budget, deadline and scan caps. Changing them re-runs local selection and planning;
 * it does not change what the provider was asked.
 *
 * What is never persisted: source text, the full question, provider request or
 * response bodies, and credentials. An entry holds a hash, a number, and the versions
 * that produced it. A corrupt, expired or incomplete entry is a miss, and a cache
 * failure disables reuse for that operation instead of failing a valid search.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDirectory, isMissing } from '../local-directory.ts';
import { isPinnedModelRevision, isRollingModel, MAX_ROLLING_TTL_SECONDS } from './policy.ts';
export { isPinnedModelRevision } from './policy.ts';

export const CACHE_SCHEMA_VERSION = 3;

/** Everything that can change a provider judgment. */
export type EvaluationIdentityInput = {
  readonly query: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly label: string | null;
  readonly criterionVersion: string;
  readonly layoutVersion: string;
  readonly chunkerVersion: string;
  readonly endpoint: string;
  /** Configured immutable revision or known rolling alias, isolated by reuse policy. */
  readonly modelRevision: string;
  /** Extra provider evaluation options, if the adapter ever sends any. */
  readonly providerOptions?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Hashes of model-visible evaluation inputs. Layout A questions are independent:
   * the engine hashes the singleton envelope, not neighboring questions.
   */
  readonly batchComposition?: readonly string[];
};

/** Stable hash of one evaluation's inputs. */
export function evaluationIdentity(input: EvaluationIdentityInput): string {
  const canonical = JSON.stringify([
    CACHE_SCHEMA_VERSION,
    input.query,
    input.path,
    input.startLine,
    input.endLine,
    input.text,
    input.label,
    input.criterionVersion,
    input.layoutVersion,
    input.chunkerVersion,
    input.endpoint.replace(/\/$/, ''),
    input.modelRevision,
    Object.entries(input.providerOptions ?? {}).sort(([left], [right]) => (left < right ? -1 : 1)),
    input.batchComposition ?? [],
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type CacheEntry = {
  readonly schema_version: number;
  readonly identity: string;
  readonly score: number;
  readonly model_revision: string;
  readonly layout: string;
  readonly criterion: string;
  readonly chunker: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
};

export type CacheOptions = {
  readonly directory: string;
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly maxBytes: number;
  /** Explicit bounded-staleness reuse for known aliases; disabled for standalone caches. */
  readonly rollingTtlSeconds?: number;
  /** Injectable clock so TTL and eviction are testable without waiting. */
  readonly now?: () => number;
};

export type CacheStats = {
  hits: number;
  misses: number;
  writes: number;
  /** Reads or writes that failed locally; they degrade reuse, never the search. */
  failures: number;
  expired: number;
  corrupt: number;
};

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return entry['schema_version'] === CACHE_SCHEMA_VERSION
    && typeof entry['identity'] === 'string'
    && typeof entry['score'] === 'number' && Number.isFinite(entry['score'])
    && entry['score'] >= 0 && entry['score'] <= 1
    && typeof entry['model_revision'] === 'string'
    && (isPinnedModelRevision(entry['model_revision']) || isRollingModel(entry['model_revision']))
    && typeof entry['layout'] === 'string'
    && typeof entry['criterion'] === 'string'
    && typeof entry['chunker'] === 'string'
    && Number.isSafeInteger(entry['created_at_ms']) && Number.isSafeInteger(entry['expires_at_ms'])
    && (entry['created_at_ms'] as number) >= 0
    && (entry['expires_at_ms'] as number) > (entry['created_at_ms'] as number);
}

/**
 * Bounded per-user score cache, one JSON file per entry.
 *
 * Per-entry files keep writes atomic and corruption local; the storage task may
 * revisit the format if profiling justifies it (specification section 9).
 */
export class ScoreCache {
  readonly #options: CacheOptions;
  readonly #storage: LocalDirectory | null;
  readonly #now: () => number;
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, failures: 0, expired: 0, corrupt: 0 };
  #sizes: Map<string, { size: number; created: number }> | null = null;
  #totalBytes = 0;
  readonly #shardStamps = new Map<string, string>();

  constructor(options: CacheOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    try { this.#storage = new LocalDirectory(options.directory); }
    catch { this.#storage = null; this.stats.failures++; }
  }

  get enabled(): boolean { return this.#options.enabled && this.#storage !== null; }
  get directory(): string { return this.#options.directory; }
  #ttl(model: string): number {
    if (isPinnedModelRevision(model)) return this.#options.ttlSeconds;
    return isRollingModel(model)
      ? Math.max(0, Math.min(this.#options.ttlSeconds, this.#options.rollingTtlSeconds ?? 0, MAX_ROLLING_TTL_SECONDS)) : 0;
  }
  #name(identity: string): string { return `${identity.slice(0, 2)}/${identity}.json`; }

  read(identity: string): number | null {
    if (!this.enabled || !/^[a-f0-9]{64}$/.test(identity)) return null;
    const name = this.#name(identity);
    let raw: string;
    try { raw = this.#storage!.read(name, 16_384).toString('utf8'); }
    catch (cause) {
      if (!isMissing(cause)) this.stats.failures++;
      this.stats.misses++; return null;
    }
    let entry: unknown;
    try { entry = JSON.parse(raw); } catch { entry = null; }
    if (!isCacheEntry(entry) || entry.identity !== identity || entry.created_at_ms > this.#now()) {
      this.stats.corrupt++; this.stats.misses++; this.#discard(name); return null;
    }
    // Enforce today's policy too: shortening/turning off the TTL must take effect
    // even for an entry created under a more permissive configuration.
    const ttl = this.#ttl(entry.model_revision);
    if (ttl <= 0 || Math.min(entry.expires_at_ms, entry.created_at_ms + ttl * 1_000) <= this.#now()) {
      this.stats.expired++; this.stats.misses++; this.#discard(name); return null;
    }
    this.stats.hits++; return entry.score;
  }

  write(identity: string, score: number, meta: {
    readonly modelRevision: string; readonly layout: string; readonly criterion: string; readonly chunker: string;
  }): boolean {
    if (!this.enabled || !/^[a-f0-9]{64}$/.test(identity) || !Number.isFinite(score) || score < 0 || score > 1
      || this.#ttl(meta.modelRevision) <= 0) return false;
    const now = this.#now();
    const entry: CacheEntry = {
      schema_version: CACHE_SCHEMA_VERSION, identity, score, model_revision: meta.modelRevision,
      layout: meta.layout, criterion: meta.criterion, chunker: meta.chunker,
      created_at_ms: now, expires_at_ms: now + this.#ttl(meta.modelRevision) * 1_000,
    };
    const raw = `${JSON.stringify(entry)}\n`;
    const size = Buffer.byteLength(raw);
    if (!isCacheEntry(entry) || size > Math.min(16_384, this.#options.maxBytes)) return false;
    try {
      return this.#storage!.withLock(() => {
      this.#loadSizes();
      const name = this.#name(identity);
      this.#storage!.write(name, raw);
      this.#totalBytes += size - (this.#sizes!.get(name)?.size ?? 0);
      this.#sizes!.set(name, { size, created: now });
      this.#shardStamps.set(identity.slice(0, 2), this.#stamp(identity.slice(0, 2)));
      this.stats.writes++;
      this.#evict();
      return true;
      });
    } catch { this.stats.failures++; this.#sizes = null; return false; }
  }

  enforceSizeLimit(): void {
    if (!this.enabled) return;
    try { this.#storage!.withLock(() => { this.#shardStamps.clear(); this.#loadSizes(); this.#evict(); }); }
    catch { this.stats.failures++; this.#sizes = null; }
  }

  #evict(): void {
    const sizes = this.#sizes!;
    if (this.#totalBytes <= this.#options.maxBytes) return;
    const oldest = [...sizes].sort(([a, left], [b, right]) => left.created - right.created || a.localeCompare(b));
    for (const [name] of oldest) {
      if (this.#totalBytes <= this.#options.maxBytes) break;
      this.#discard(name);
    }
  }

  #loadSizes(): void {
    this.#sizes = this.#listEntries();
    this.#totalBytes = [...this.#sizes.values()].reduce((sum, entry) => sum + entry.size, 0);
  }

  #stamp(shard: string): string {
    const stat = lstatSync(join(this.#storage!.path, shard), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /** Only valid entry names are removed; never traverse links or recursively delete a directory. */
  clear(): number {
    if (this.#storage === null) return 0;
    try {
      return this.#storage.withLock(() => {
      this.#shardStamps.clear();
      const entries = this.#listEntries();
      let removed = 0;
      for (const name of entries.keys()) if (this.#discard(name)) removed++;
      this.#sizes = null;
      return removed;
      });
    } catch { this.stats.failures++; return 0; }
  }

  #listEntries(): Map<string, { size: number; created: number }> {
    if (this.#sizes === null) this.#shardStamps.clear();
    const entries = this.#sizes ?? new Map<string, { size: number; created: number }>();
    let root;
    try { root = this.#storage!.root(); }
    catch (cause) { if (isMissing(cause)) return entries; throw cause; }
    const seenShards = new Set<string>();
    for (const shard of root.readDirectory('.')) {
      if (!/^[a-f0-9]{2}$/.test(shard.name)) continue;
      seenShards.add(shard.name);
      try {
        const stamp = this.#stamp(shard.name);
        if (this.#shardStamps.get(shard.name) === stamp) continue;
        for (const name of entries.keys()) if (name.startsWith(`${shard.name}/`)) entries.delete(name);
        for (const file of root.readDirectory(shard.name)) {
          if (!/^[a-f0-9]{64}\.json$/.test(file.name) || !file.name.startsWith(shard.name)) continue;
          const name = `${shard.name}/${file.name}`;
          try {
          const entry = root.resolveEntry(name);
          if (entry.kind !== 'file') continue;
          let created = 0;
          try {
            const parsed: unknown = JSON.parse(this.#storage!.read(name, 16_384).toString('utf8'));
            if (isCacheEntry(parsed)) created = parsed.created_at_ms;
          } catch { /* corrupt/oversized entries are evicted first, without unbounded reads */ }
          entries.set(name, { size: entry.sizeBytes, created });
          } catch (cause) { if (!isMissing(cause)) this.stats.failures++; }
        }
        this.#shardStamps.set(shard.name, stamp);
      } catch (cause) { if (!isMissing(cause)) this.stats.failures++; }
    }
    for (const name of entries.keys()) if (!seenShards.has(name.slice(0, 2))) entries.delete(name);
    root.assertCurrent();
    return entries;
  }

  #discard(name: string): boolean {
    try {
      const removed = this.#storage!.remove(name);
      this.#totalBytes -= this.#sizes?.get(name)?.size ?? 0;
      this.#sizes?.delete(name);
      return removed;
    } catch { this.stats.failures++; return false; }
  }
}
