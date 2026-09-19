/**
 * Search lifecycle, cancellation, deadline and local diagnostics (JG-009).
 *
 * Every stage of the engine receives the same `SearchContext`: one identity, one
 * clock, one stop signal and one deadline. Two stops are deliberately distinct
 * (specification sections 4.4 and 10): an internal deadline still returns flagged
 * partial evidence, while a client cancellation must not produce a new result at all.
 *
 * Diagnostics stay local and bounded. They carry timings, counters and stable codes,
 * never source text, credentials, provider bodies or the full search question.
 */
import { randomUUID } from 'node:crypto';

import { CONTRACT_LIMITS, SCHEMA_VERSION, diagnosticsSchema } from './contracts.ts';
import type { Diagnostics, ScanCap, StopReason } from './contracts.ts';

/** Minimal clock seam. `ManualClock` in src/testing satisfies it structurally. */
export type Clock = {
  readonly nowMs: number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
};

/** Wall-clock implementation. Timers are unref'd: a pending deadline never holds the process open. */
export const systemClock: Clock = {
  get nowMs(): number {
    return Date.now();
  },
  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException('operation aborted', 'AbortError'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      timer.unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('operation aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

/** Why the search stopped accepting new work. */
export type StopKind = 'deadline' | 'client_cancelled';

/** Coarse stages, used for local timing lines and nothing else. */
export type Phase = 'inventory' | 'preparation' | 'planning' | 'evaluation' | 'selection' | 'rendering';

export type DiagnosticCode = Diagnostics['events'][number]['code'];

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Metadata-only logger. Callers pass counters and codes, never source or question text. */
export class SearchLogger {
  readonly #level: LogLevel;
  readonly #write: (line: string) => void;

  constructor(level: LogLevel = 'info', write: (line: string) => void = () => undefined) {
    this.#level = level;
    this.#write = write;
  }

  log(level: Exclude<LogLevel, 'silent'>, searchId: string, event: string, fields: Record<string, number | string | boolean> = {}): void {
    if (LEVEL_ORDER[this.#level] < LEVEL_ORDER[level]) {
      return;
    }
    const rendered = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`).join(' ');
    this.#write(`jevgrep ${level} search=${searchId} ${event}${rendered.length > 0 ? ` ${rendered}` : ''}`);
  }
}

/**
 * Bounded diagnostic record for one search.
 *
 * Events past the contract limit are dropped and flagged instead of growing without
 * bound, so a pathological repository cannot turn diagnostics into a memory leak or
 * an oversized local log.
 */
export class DiagnosticsRecorder {
  readonly #searchId: string;
  readonly #events: Diagnostics['events'][number][] = [];
  readonly #excludedDirectories = new Map<string, number>();
  readonly #capLowerBounds = new Map<ScanCap, number>();
  #truncated = false;
  #responseTokens: number | null = null;

  constructor(searchId: string) {
    this.#searchId = searchId;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  record(code: DiagnosticCode, elapsedMs: number, extra: { count?: number; path?: string } = {}): void {
    if (this.#events.length >= CONTRACT_LIMITS.diagnostic_events) {
      this.#truncated = true;
      return;
    }
    const event = {
      code, elapsed_ms: Math.max(0, Math.round(elapsedMs)),
      ...(extra.count === undefined ? {} : { count: extra.count }),
      ...(extra.path === undefined ? {} : { path: extra.path }),
    };
    this.#events.push(event);
  }

  /** Directories that were never entered: their descendants stay unknown, never invented. */
  recordExcludedDirectory(reason: string): void {
    this.#excludedDirectories.set(reason, (this.#excludedDirectories.get(reason) ?? 0) + 1);
  }

  /** Observed lower bound for a cap whose exact requirement could not be computed. */
  observeCapLowerBound(cap: ScanCap, value: number): void {
    this.#capLowerBounds.set(cap, Math.max(this.#capLowerBounds.get(cap) ?? 0, value));
  }

  setResponseTokensMeasured(tokens: number): void {
    this.#responseTokens = tokens;
  }

  toJSON(): Diagnostics {
    return diagnosticsSchema.parse({
      schema_version: SCHEMA_VERSION,
      search_id: this.#searchId,
      events: this.#events,
      excluded_directories_by_reason: Object.fromEntries(this.#excludedDirectories),
      observed_cap_lower_bounds: Object.fromEntries(this.#capLowerBounds),
      response_tokens_measured: this.#responseTokens,
      truncated: this.#truncated,
    });
  }
}

export type SearchContextOptions = {
  readonly searchId?: string;
  readonly clock?: Clock;
  /** Trusted admission time on the same clock, including any queue wait. */
  readonly startedAtMs?: number;
  readonly deadlineMs?: number;
  /** Client cancellation, for example an MCP cancel notification or SIGINT. */
  readonly clientSignal?: AbortSignal;
  readonly logger?: SearchLogger;
};

/**
 * One search's identity, time budget, stop signal and cleanup list.
 *
 * Queue waiting uses this same context, so time spent waiting for a slot counts
 * against the deadline exactly like time spent evaluating.
 */
export class SearchContext {
  readonly searchId: string;
  readonly clock: Clock;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly diagnostics: DiagnosticsRecorder;
  readonly logger: SearchLogger;

  readonly #controller = new AbortController();
  readonly #cleanups: (() => void | Promise<void>)[] = [];
  readonly #stopReasons = new Set<StopReason>();
  #stop: StopKind | null = null;
  #disposed = false;

  constructor(options: SearchContextOptions = {}) {
    this.searchId = options.searchId ?? randomUUID();
    this.clock = options.clock ?? systemClock;
    this.startedAtMs = options.startedAtMs ?? this.clock.nowMs;
    this.deadlineAtMs = this.startedAtMs + (options.deadlineMs ?? 60_000);
    this.diagnostics = new DiagnosticsRecorder(this.searchId);
    this.logger = options.logger ?? new SearchLogger('silent');

    const client = options.clientSignal;
    if (client !== undefined) {
      if (client.aborted) {
        this.#stopNow('client_cancelled');
      } else {
        const onAbort = (): void => this.#stopNow('client_cancelled');
        client.addEventListener('abort', onAbort, { once: true });
        this.#cleanups.push(() => client.removeEventListener('abort', onAbort));
      }
    }

    // The deadline is a clock sleep, not a wall-clock timer, so a manual clock can
    // fire it in a test without waiting.
    if (this.#stop === null) {
      void this.clock.sleep(Math.max(0, this.deadlineAtMs - this.clock.nowMs), this.#controller.signal)
        .then(() => this.#stopNow('deadline'), () => undefined);
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get stop(): StopKind | null {
    this.#checkDeadline();
    return this.#stop;
  }

  get elapsedMs(): number {
    return Math.max(0, this.clock.nowMs - this.startedAtMs);
  }

  get remainingMs(): number {
    return Math.max(0, this.deadlineAtMs - this.clock.nowMs);
  }

  /** False once the deadline passed or the client cancelled: no new task may start. */
  canStartWork(): boolean {
    return this.stop === null;
  }

  /** Client-side cancellation; no new result may be emitted afterwards. */
  cancel(): void {
    this.#stopNow('client_cancelled');
  }

  /** Stop reasons accumulated for the report, kept unique and in contract order. */
  addStopReason(reason: StopReason): void {
    this.#stopReasons.add(reason);
  }

  stopReasons(): StopReason[] {
    this.#checkDeadline();
    return [...this.#stopReasons];
  }

  /** Register a handle, permit or watcher released on every exit path. */
  onDispose(cleanup: () => void | Promise<void>): void {
    this.#cleanups.push(cleanup);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#controller.abort();
    const cleanups = this.#cleanups.splice(0, this.#cleanups.length).reverse();
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        // A failing cleanup must not mask the search outcome; the remaining handles
        // still get their chance to release.
      }
    }
  }

  #checkDeadline(): void {
    if (this.#stop === null && this.clock.nowMs >= this.deadlineAtMs) {
      this.#stopNow('deadline');
    }
  }

  #stopNow(kind: StopKind): void {
    if (this.#stop !== null) {
      return;
    }
    this.#stop = kind;
    this.#stopReasons.add(kind === 'deadline' ? 'DEADLINE' : 'CANCELLED');
    this.diagnostics.record(kind === 'deadline' ? 'DEADLINE' : 'CANCELLED', this.elapsedMs);
    this.logger.log('info', this.searchId, kind === 'deadline' ? 'deadline' : 'cancelled', { elapsed_ms: this.elapsedMs });
    this.#controller.abort();
  }
}

/** True for the abort shapes produced by the system clock, the manual clock and fetch. */
export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

/**
 * Time one phase and log its duration and counters. Failures and cancellations are
 * logged with their stage so a local trace still distinguishes them.
 */
export async function runPhase<T>(
  context: SearchContext,
  phase: Phase,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = context.clock.nowMs;
  try {
    const value = await body();
    context.logger.log('debug', context.searchId, `phase.${phase}`, { duration_ms: Math.max(0, context.clock.nowMs - startedAt) });
    return value;
  } catch (cause) {
    context.logger.log('warn', context.searchId, `phase.${phase}.failed`, {
      duration_ms: Math.max(0, context.clock.nowMs - startedAt),
      cancelled: isAbortError(cause),
    });
    throw cause;
  }
}
