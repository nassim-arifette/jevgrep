export type Clock = {
  readonly nowMs: number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
};

type PendingTimer = {
  readonly id: number;
  readonly dueAtMs: number;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
};

export class AbortError extends Error {
  override readonly name = 'AbortError';

  constructor(message = 'operation aborted') {
    super(message);
  }
}

function requireDelay(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delay must be a finite non-negative number, received ${String(delayMs)}`);
  }
}

/** Deterministic clock used by offline provider and lifecycle tests. */
export class ManualClock implements Clock {
  #nowMs: number;
  #nextId = 0;
  readonly #timers: PendingTimer[] = [];

  constructor(initialTimeMs = 0) {
    requireDelay(initialTimeMs);
    this.#nowMs = initialTimeMs;
  }

  get nowMs(): number {
    return this.#nowMs;
  }

  get pendingTimerCount(): number {
    return this.#timers.length;
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    requireDelay(delayMs);
    const dueAtMs = this.#nowMs + delayMs;
    requireDelay(dueAtMs);
    if (signal?.aborted === true) {
      return Promise.reject(new AbortError());
    }

    return new Promise<void>((resolve, reject) => {
      const id = this.#nextId++;
      const onAbort = signal === undefined
        ? undefined
        : (): void => {
            const index = this.#timers.findIndex((timer) => timer.id === id);
            if (index !== -1) {
              this.#timers.splice(index, 1);
            }
            reject(new AbortError());
          };
      const timer: PendingTimer = {
        id,
        dueAtMs,
        resolve,
        reject,
        signal,
        onAbort,
      };
      this.#timers.push(timer);
      this.#timers.sort((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id);
      signal?.addEventListener('abort', onAbort as () => void, { once: true });
    });
  }

  advanceBy(elapsedMs: number): void {
    requireDelay(elapsedMs);
    this.advanceTo(this.#nowMs + elapsedMs);
  }

  advanceTo(timeMs: number): void {
    requireDelay(timeMs);
    if (timeMs < this.#nowMs) {
      throw new RangeError('manual clock cannot move backwards');
    }
    this.#nowMs = timeMs;

    while ((this.#timers[0]?.dueAtMs ?? Number.POSITIVE_INFINITY) <= timeMs) {
      const timer = this.#timers.shift();
      if (timer === undefined) {
        break;
      }
      if (timer.onAbort !== undefined) {
        timer.signal?.removeEventListener('abort', timer.onAbort);
      }
      timer.resolve();
    }
  }

  runAll(): void {
    while (this.#timers.length > 0) {
      this.advanceTo(this.#timers[0]?.dueAtMs ?? this.#nowMs);
    }
  }
}
