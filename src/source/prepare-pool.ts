/**
 * Worker pool for the content stage of preparation (snapshot, scan, chunking).
 *
 * A worker receives one file's bytes and returns the preparation entry it computed:
 * verdict, per-line tokens and fragment boundaries, never text. The main thread then
 * rebuilds the fragments from the bytes it read itself, through the same path a
 * preparation-cache hit takes, so the result is the one sequential preparation gives.
 *
 * Collection is synchronous (`Atomics.wait` on a per-worker counter, then
 * `receiveMessageOnPort`), so the pool serves the synchronous `prepareScope` and the
 * cooperative variant alike; a worker that fails hands its files back to the caller.
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

export type PrepareJobResult = { readonly entry: PreparationEntry } | { readonly failed: true };

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

/** Threads the pool uses by default: the other cores, bounded; `JEVGREP_PREPARE_THREADS` overrides. */
export function defaultPrepareThreads(env: NodeJS.ProcessEnv = process.env): number {
  const override = env['JEVGREP_PREPARE_THREADS'];
  if (override !== undefined && /^\d+$/.test(override)) return Math.min(Number(override), MAX_THREADS);
  return Math.max(0, Math.min(MAX_THREADS, availableParallelism() - 1));
}

export class PreparePool {
  readonly #slots: WorkerSlot[] = [];
  readonly #results = new Map<number, PrepareJobResult>();
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

  /** Queue one file; the ticket collects its result in any order. */
  submit(job: PrepareJob): number {
    const ticket = this.#next;
    this.#next += 1;
    const slot = this.#slots.reduce((least, candidate) => (candidate.queued - candidate.consumed < least.queued - least.consumed ? candidate : least));
    slot.queued += 1;
    this.#assigned.set(ticket, slot);
    const bytes = new Uint8Array(job.bytes.byteLength);
    bytes.set(job.bytes);
    slot.worker.postMessage({
      ticket, relativePath: job.relativePath, absolutePath: job.absolutePath, bytes: bytes.buffer, sha256: job.sha256, windowLimits: job.windowLimits,
    }, [bytes.buffer]);
    return ticket;
  }

  /** Block until the ticket's result is available. */
  collect(ticket: number): PrepareJobResult {
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
      const message = received.message as { ticket: number; entry?: PreparationEntry; failed?: true };
      this.#results.set(message.ticket, message.entry === undefined ? { failed: true } : { entry: message.entry });
    }
  }

  close(): void {
    for (const slot of this.#slots) void slot.worker.terminate();
    this.#slots.length = 0;
  }
}
