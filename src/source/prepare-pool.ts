/**
 * Worker pool for the CPU stages that are a pure function of their input: the content
 * stage of preparation (snapshot, scan, chunking) and reference token counts.
 *
 * For a file, a worker receives the bytes and returns the preparation entry it
 * computed: verdict, per-line tokens and fragment boundaries, never text. The main
 * thread then rebuilds the fragments from the bytes it read itself, through the same
 * path a preparation-cache hit takes, so the result is the one sequential preparation
 * gives. For token counts, a worker receives texts and returns their counts.
 *
 * Collection is synchronous (`Atomics.wait` on a per-worker counter, then
 * `receiveMessageOnPort`), so the pool serves the synchronous `prepareScope` and the
 * cooperative variant alike; a worker that fails hands its work back to the caller.
 */
import { availableParallelism } from 'node:os';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { WindowLimits } from './chunker.ts';
import type { PreparationEntry } from './preparation-cache.ts';

export type PrepareJob = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly windowLimits: WindowLimits;
};

export type PoolResult = { readonly entry: PreparationEntry } | { readonly counts: readonly number[] } | { readonly failed: true };

type WorkerSlot = {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly counter: Int32Array;
  consumed: number;
  queued: number;
  failed: boolean;
};

/** Bytes below which a pool costs more to start than it saves. */
export const PREPARE_POOL_MIN_BYTES = 1_048_576;
const MAX_THREADS = 7;
const JOB_TIMEOUT_MS = 120_000;
/** An idle shared pool closes after this long, so a long-lived server does not keep the workers. */
const SHARED_POOL_IDLE_MS = 30_000;

/** Threads the pool uses by default: the other cores, bounded; `JEVGREP_PREPARE_THREADS` overrides. */
export function defaultPrepareThreads(env: NodeJS.ProcessEnv = process.env): number {
  const override = env['JEVGREP_PREPARE_THREADS'];
  if (override !== undefined && /^\d+$/.test(override)) return Math.min(Number(override), MAX_THREADS);
  return Math.max(0, Math.min(MAX_THREADS, availableParallelism() - 1));
}

export class PreparePool {
  readonly #slots: WorkerSlot[] = [];
  readonly #results = new Map<number, PoolResult>();
  readonly #assigned = new Map<number, WorkerSlot>();
  #next = 0;

  constructor(threads: number) {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    for (let index = 0; index < threads; index += 1) {
      const channel = new MessageChannel();
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const worker = new Worker(new URL(`./prepare-worker.${extension}`, import.meta.url), {
        execArgv: [], workerData: { port: channel.port2, counter: counter.buffer }, transferList: [channel.port2],
      });
      const slot: WorkerSlot = { worker, port: channel.port1, counter, consumed: 0, queued: 0, failed: false };
      worker.on('error', () => { slot.failed = true; Atomics.notify(counter, 0); });
      worker.on('exit', () => { slot.failed = true; Atomics.notify(counter, 0); });
      worker.unref();
      this.#slots.push(slot);
    }
  }

  get size(): number { return this.#slots.length; }

  #leastLoaded(): { slot: WorkerSlot; ticket: number } {
    const ticket = this.#next;
    this.#next += 1;
    const slot = this.#slots.reduce((least, candidate) => (candidate.queued - candidate.consumed < least.queued - least.consumed ? candidate : least));
    slot.queued += 1;
    this.#assigned.set(ticket, slot);
    return { slot, ticket };
  }

  /** Queue one file; the ticket collects its result in any order. */
  submit(job: PrepareJob): number {
    const { slot, ticket } = this.#leastLoaded();
    const bytes = new Uint8Array(job.bytes.byteLength);
    bytes.set(job.bytes);
    slot.worker.postMessage({
      kind: 'prepare', ticket, relativePath: job.relativePath, absolutePath: job.absolutePath, bytes: bytes.buffer, sha256: job.sha256, windowLimits: job.windowLimits,
    }, [bytes.buffer]);
    return ticket;
  }

  /** Queue texts to count with the reference tokenizer; counts come back in the same order. */
  submitCount(texts: readonly string[]): number {
    const { slot, ticket } = this.#leastLoaded();
    slot.worker.postMessage({ kind: 'count', ticket, texts });
    return ticket;
  }

  /** Block until the ticket's result is available. */
  collect(ticket: number): PoolResult {
    const slot = this.#assigned.get(ticket);
    if (slot === undefined) return { failed: true };
    this.#assigned.delete(ticket);
    for (;;) {
      const ready = this.#results.get(ticket);
      if (ready !== undefined) { this.#results.delete(ticket); return ready; }
      if (slot.failed) return { failed: true };
      if (Atomics.load(slot.counter, 0) <= slot.consumed) {
        const waited = Atomics.wait(slot.counter, 0, slot.consumed, JOB_TIMEOUT_MS);
        if (waited === 'timed-out') { slot.failed = true; void slot.worker.terminate(); return { failed: true }; }
        continue;
      }
      const received = receiveMessageOnPort(slot.port);
      if (received === undefined) { if (slot.failed) return { failed: true }; continue; }
      slot.consumed += 1;
      const message = received.message as { ticket: number; entry?: PreparationEntry; counts?: number[]; failed?: true };
      this.#results.set(message.ticket, message.entry !== undefined ? { entry: message.entry }
        : message.counts !== undefined ? { counts: message.counts } : { failed: true });
    }
  }

  close(): void {
    for (const slot of this.#slots) void slot.worker.terminate();
    this.#slots.length = 0;
  }
}

let shared: { pool: PreparePool; threads: number; users: number; idle: NodeJS.Timeout | null } | null = null;

/**
 * The process-wide pool, started on first use and closed after idling. `threads`
 * defaults to the other cores; a caller naming a count that differs from the shared
 * pool's gets a pool of its own. Null when no thread is to be used.
 */
export function acquirePool(threads: number = defaultPrepareThreads()): { readonly pool: PreparePool; readonly release: () => void } | null {
  if (threads < 1) return null;
  try {
    if (shared !== null && shared.threads !== threads) {
      const own = new PreparePool(threads);
      return { pool: own, release: () => { own.close(); } };
    }
    if (shared === null) shared = { pool: new PreparePool(threads), threads, users: 0, idle: null };
    const entry = shared;
    if (entry.idle !== null) { clearTimeout(entry.idle); entry.idle = null; }
    entry.users += 1;
    let released = false;
    return {
      pool: entry.pool,
      release: () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        if (entry.users > 0) return;
        entry.idle = setTimeout(() => {
          if (shared === entry && entry.users === 0) { entry.pool.close(); shared = null; }
        }, SHARED_POOL_IDLE_MS);
        entry.idle.unref();
      },
    };
  } catch {
    return null;
  }
}

/**
 * Reference token counts of many texts, spread over the pool in chunks of about a
 * megabyte; the calling thread counts when there is no pool or a worker failed.
 */
export function countTokensWith(pool: PreparePool | null, texts: readonly string[], count: (text: string) => number): number[] {
  if (pool === null || texts.length < 2) return texts.map(count);
  const chunkChars = Math.max(65_536, Math.ceil(texts.reduce((total, text) => total + text.length, 0) / (pool.size * 4)));
  const chunks: { start: number; end: number; ticket: number }[] = [];
  let start = 0;
  while (start < texts.length) {
    let end = start;
    let chars = 0;
    while (end < texts.length && (end === start || chars + texts[end]!.length <= chunkChars)) { chars += texts[end]!.length; end += 1; }
    chunks.push({ start, end, ticket: pool.submitCount(texts.slice(start, end)) });
    start = end;
  }
  const counts = new Array<number>(texts.length);
  for (const chunk of chunks) {
    const result = pool.collect(chunk.ticket);
    if ('counts' in result && result.counts.length === chunk.end - chunk.start) {
      for (let index = chunk.start; index < chunk.end; index += 1) counts[index] = result.counts[index - chunk.start]!;
    } else {
      for (let index = chunk.start; index < chunk.end; index += 1) counts[index] = count(texts[index]!);
    }
  }
  return counts;
}
