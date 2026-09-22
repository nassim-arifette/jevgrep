/** Opt-in, search-local measurements. Never retains queries, paths or source text. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type ProfileStage =
  | 'search' | 'preparation' | 'inventory' | 'source_read' | 'snapshot'
  | 'decode' | 'hash' | 'secret_scan' | 'chunking' | 'parsing' | 'tokenization'
  | 'cache_lookup' | 'cache_write' | 'serialization' | 'batching' | 'planning'
  | 'evaluation' | 'provider' | 'selection' | 'freshness' | 'rendering';

type Measurement = { calls: number; durationMs: number };
type Memory = { rssBytes: number; heapUsedBytes: number; externalBytes: number };
export type SearchProfile = {
  /** Inclusive durations: nested and concurrent stages must not be added together. */
  stages: Partial<Record<ProfileStage, Measurement>>;
  counters: Readonly<Record<string, number>>;
  memory: { start: Memory; end: Memory; sampledMax: Memory; samples: number };
};

const active = new AsyncLocalStorage<SearchProfiler | undefined>();

function memory(): Memory {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external };
}

/** One instance per invocation. The caller owns the local diagnostic output. */
export class SearchProfiler {
  readonly #stages: SearchProfile['stages'] = {};
  readonly #counters: Record<string, number> = {};
  #start: Memory | undefined;
  #end: Memory | undefined;
  #max: Memory | undefined;
  #samples = 0;
  #lastSampleAt = -Infinity;
  #used = false;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#used) throw new Error('use a new SearchProfiler for each search');
    this.#used = true;
    this.#sample();
    try {
      return await active.run(this, () => measureAsync('search', work));
    } finally {
      this.#sample();
    }
  }

  record(stage: ProfileStage, durationMs: number): void {
    const entry = this.#stages[stage] ??= { calls: 0, durationMs: 0 };
    entry.calls += 1;
    entry.durationMs += durationMs;
    // Sample at instrumented boundaries, even while synchronous work blocks timers.
    // This is an observed high-water mark, not a guaranteed peak allocation.
    if (performance.now() - this.#lastSampleAt >= 20) this.#sample();
  }

  count(name: string, value: number): void {
    this.#counters[name] = (this.#counters[name] ?? 0) + value;
  }

  snapshot(): SearchProfile {
    if (this.#start === undefined || this.#end === undefined || this.#max === undefined) {
      throw new Error('profile has not run');
    }
    return structuredClone({
      stages: this.#stages, counters: this.#counters,
      memory: { start: this.#start, end: this.#end, sampledMax: this.#max, samples: this.#samples },
    });
  }

  #sample(): void {
    const sample = memory();
    this.#start ??= sample;
    this.#end = sample;
    this.#max = {
      rssBytes: Math.max(this.#max?.rssBytes ?? 0, sample.rssBytes),
      heapUsedBytes: Math.max(this.#max?.heapUsedBytes ?? 0, sample.heapUsedBytes),
      externalBytes: Math.max(this.#max?.externalBytes ?? 0, sample.externalBytes),
    };
    this.#samples += 1;
    this.#lastSampleAt = performance.now();
  }
}

export function withSearchProfile<T>(profile: SearchProfiler | undefined, work: () => Promise<T>): Promise<T> {
  return profile === undefined ? active.run(undefined, work) : profile.run(work);
}

export function measureSync<T>(stage: ProfileStage, work: () => T): T {
  const profile = active.getStore();
  if (profile === undefined) return work();
  const start = performance.now();
  try { return work(); }
  finally { profile.record(stage, performance.now() - start); }
}

export async function measureAsync<T>(stage: ProfileStage, work: () => Promise<T>): Promise<T> {
  const profile = active.getStore();
  if (profile === undefined) return work();
  const start = performance.now();
  try { return await work(); }
  finally { profile.record(stage, performance.now() - start); }
}

export function countProfile(name: string, value: number | (() => number) = 1): void {
  const profile = active.getStore();
  if (profile !== undefined) profile.count(name, typeof value === 'function' ? value() : value);
}
