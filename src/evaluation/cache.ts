/**
 * Exact evaluation cache (JG-018).
 *
 * The cache exists to avoid paying twice for *the same* judgment, never to reuse a
 * judgment whose inputs moved. Its identity therefore hashes everything the model can
 * see — the exact query, the criterion and its version, the request layout, the
 * provider endpoint, the pinned model revision, the transmitted path and line range,
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
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const CACHE_SCHEMA_VERSION = 1;

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
  /** The model revision that answered, or the configured id when it is already pinned. */
  readonly modelRevision: string;
  /** Extra provider evaluation options, if the adapter ever sends any. */
  readonly providerOptions?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Ordered ids of the whole batch, for layouts whose question independence is not
   * verified. Layout A keeps this empty: its shared state holds no other excerpt.
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
    input.label ?? '',
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

/**
 * A model alias such as `jev-latest` cannot anchor a cross-session reuse: the same
 * alias can answer with a different revision tomorrow (specification section 9).
 */
export function isPinnedModelRevision(model: string): boolean {
  return /\d/.test(model) && !/(?:^|[-_])latest$/i.test(model) && !/(?:^|[-_])preview$/i.test(model);
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
    && typeof entry['layout'] === 'string'
    && typeof entry['criterion'] === 'string'
    && typeof entry['chunker'] === 'string'
    && typeof entry['created_at_ms'] === 'number'
    && typeof entry['expires_at_ms'] === 'number';
}

/**
 * Bounded per-user score cache, one JSON file per entry.
 *
 * Per-entry files keep writes atomic and corruption local; the storage task may
 * revisit the format if profiling justifies it (specification section 9).
 */
export class ScoreCache {
  readonly #directory: string;
  readonly #enabled: boolean;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, failures: 0, expired: 0, corrupt: 0 };
  #writesSinceSweep = 0;

  constructor(options: CacheOptions) {
    this.#directory = options.directory;
    this.#enabled = options.enabled;
    this.#ttlMs = options.ttlSeconds * 1_000;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get directory(): string {
    return this.#directory;
  }

  #pathOf(identity: string): string {
    return join(this.#directory, identity.slice(0, 2), `${identity}.json`);
  }

  /** Validated score for an identity, or null for any kind of miss. */
  read(identity: string): number | null {
    if (!this.#enabled) {
      return null;
    }
    const file = this.#pathOf(identity);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.stats.failures += 1;
      }
      this.stats.misses += 1;
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.stats.corrupt += 1;
      this.stats.misses += 1;
      this.#discard(file);
      return null;
    }
    if (!isCacheEntry(parsed) || parsed.identity !== identity) {
      this.stats.corrupt += 1;
      this.stats.misses += 1;
      this.#discard(file);
      return null;
    }
    if (parsed.expires_at_ms <= this.#now()) {
      this.stats.expired += 1;
      this.stats.misses += 1;
      this.#discard(file);
      return null;
    }
    this.stats.hits += 1;
    return parsed.score;
  }

  /**
   * Store one validated score.
   *
   * A model whose revision is not identifiable is never persisted: the entry could
   * not be trusted in a later session.
   */
  write(identity: string, score: number, meta: {
    readonly modelRevision: string; readonly layout: string;
    readonly criterion: string; readonly chunker: string;
  }): boolean {
    if (!this.#enabled || !Number.isFinite(score) || score < 0 || score > 1) {
      return false;
    }
    if (!isPinnedModelRevision(meta.modelRevision)) {
      return false;
    }
    const now = this.#now();
    const entry: CacheEntry = {
      schema_version: CACHE_SCHEMA_VERSION,
      identity,
      score,
      model_revision: meta.modelRevision,
      layout: meta.layout,
      criterion: meta.criterion,
      chunker: meta.chunker,
      created_at_ms: now,
      expires_at_ms: now + this.#ttlMs,
    };
    const file = this.#pathOf(identity);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(join(this.#directory, identity.slice(0, 2)), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
      this.stats.writes += 1;
      this.#writesSinceSweep += 1;
      if (this.#writesSinceSweep >= 64) {
        this.enforceSizeLimit();
      }
      return true;
    } catch {
      this.stats.failures += 1;
      this.#discard(temporary);
      return false;
    }
  }

  /** Drop the oldest entries until the directory fits its configured size. */
  enforceSizeLimit(): void {
    this.#writesSinceSweep = 0;
    let entries: { path: string; size: number; created: number }[];
    try {
      entries = this.#listEntries();
    } catch {
      this.stats.failures += 1;
      return;
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.#maxBytes) {
      return;
    }
    entries.sort((left, right) => left.created - right.created);
    for (const entry of entries) {
      if (total <= this.#maxBytes) {
        break;
      }
      this.#discard(entry.path);
      total -= entry.size;
    }
  }

  /** Remove every entry of this configured cache, and nothing else. */
  clear(): number {
    let removed = 0;
    let entries: { path: string; size: number; created: number }[];
    try {
      entries = this.#listEntries();
    } catch {
      return 0;
    }
    for (const entry of entries) {
      this.#discard(entry.path);
      removed += 1;
    }
    try {
      rmSync(this.#directory, { recursive: true, force: true });
    } catch {
      this.stats.failures += 1;
    }
    return removed;
  }

  #listEntries(): { path: string; size: number; created: number }[] {
    const found: { path: string; size: number; created: number }[] = [];
    let shards: string[];
    try {
      shards = readdirSync(this.#directory);
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') {
        return found;
      }
      throw cause;
    }
    for (const shard of shards) {
      const shardPath = join(this.#directory, shard);
      let names: string[];
      try {
        names = readdirSync(shardPath);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(shardPath, name);
        try {
          const stats = statSync(file);
          if (stats.isFile()) {
            found.push({ path: file, size: stats.size, created: stats.mtimeMs });
          }
        } catch {
          // Concurrent removal: nothing to account for.
        }
      }
    }
    return found;
  }

  #discard(file: string): void {
    try {
      rmSync(file, { force: true });
    } catch {
      this.stats.failures += 1;
    }
  }
}
