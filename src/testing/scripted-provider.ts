import { AbortError, type Clock } from './manual-clock.ts';

export type DeclaredUsage = number | null;

export type ScriptedSuccess = {
  readonly kind: 'success';
  readonly id: string;
  readonly delayMs: number;
  readonly response: unknown;
  /** null means the provider did not report usage; it must never be changed to zero. */
  readonly declaredUsage: DeclaredUsage;
};

export type ScriptedHttpError = {
  readonly kind: 'http-error';
  readonly id: string;
  readonly delayMs: number;
  readonly status: number;
  readonly body: string;
};

export type ScriptedFailure = {
  readonly kind: 'failure';
  readonly id: string;
  readonly delayMs: number;
  readonly message: string;
};

export type ScriptedStep = ScriptedSuccess | ScriptedHttpError | ScriptedFailure;

export type ProviderResult = {
  readonly response: unknown;
  readonly declaredUsage: DeclaredUsage;
};

export type ObservedAttempt = {
  readonly attempt: number;
  readonly stepId: string;
  readonly startedAtMs: number;
  readonly requestBytes: Uint8Array;
};

export class ScriptedHttpResponseError extends Error {
  override readonly name = 'ScriptedHttpResponseError';
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`scripted provider returned HTTP ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

function validateStep(step: ScriptedStep): void {
  if (step.id.length === 0) {
    throw new Error('scripted step id must not be empty');
  }
  if (!Number.isFinite(step.delayMs) || step.delayMs < 0) {
    throw new RangeError(`step '${step.id}' has an invalid delay`);
  }
  if (step.kind === 'success' && step.declaredUsage !== null) {
    if (!Number.isSafeInteger(step.declaredUsage) || step.declaredUsage < 0) {
      throw new RangeError(`step '${step.id}' has invalid declared usage`);
    }
  }
  if (step.kind === 'http-error' && (!Number.isInteger(step.status) || step.status < 100 || step.status > 599)) {
    throw new RangeError(`step '${step.id}' has an invalid HTTP status`);
  }
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AbortError();
  }
}

/**
 * Offline, script-driven provider seam for JG-003.
 *
 * It deliberately accepts and returns unvalidated payloads. JG-002 owns public
 * schemas; consumers can use this fake to exercise malformed and missing answers
 * without the fake silently normalizing them.
 */
export class ScriptedProvider {
  readonly #clock: Clock;
  readonly #steps: readonly ScriptedStep[];
  readonly #attempts: ObservedAttempt[] = [];
  readonly #completionOrder: string[] = [];
  #nextStep = 0;

  constructor(clock: Clock, steps: readonly ScriptedStep[]) {
    for (const step of steps) {
      validateStep(step);
    }
    const ids = new Set(steps.map((step) => step.id));
    if (ids.size !== steps.length) {
      throw new Error('scripted step ids must be unique');
    }
    this.#clock = clock;
    // Scenarios are captured once. Caller edits must not alter delayed responses.
    this.#steps = structuredClone(steps);
  }

  get attempts(): readonly ObservedAttempt[] {
    return this.#attempts.map((attempt) => ({ ...attempt, requestBytes: attempt.requestBytes.slice() }));
  }

  get completionOrder(): readonly string[] {
    return [...this.#completionOrder];
  }

  get remainingStepCount(): number {
    return this.#steps.length - this.#nextStep;
  }

  async evaluate(request: string | Uint8Array, signal?: AbortSignal): Promise<ProviderResult> {
    abortIfNeeded(signal);
    const step = this.#steps[this.#nextStep];
    if (step === undefined) {
      throw new Error(`scripted provider exhausted after ${String(this.#nextStep)} attempt(s)`);
    }
    this.#nextStep += 1;

    const requestBytes = typeof request === 'string'
      ? new TextEncoder().encode(request)
      : Uint8Array.from(request); // Buffer.slice() would retain caller-owned memory.
    this.#attempts.push({
      attempt: this.#nextStep,
      stepId: step.id,
      startedAtMs: this.#clock.nowMs,
      requestBytes,
    });

    await this.#clock.sleep(step.delayMs, signal);
    abortIfNeeded(signal);
    this.#completionOrder.push(step.id);

    switch (step.kind) {
      case 'success':
        return { response: structuredClone(step.response), declaredUsage: step.declaredUsage };
      case 'http-error':
        throw new ScriptedHttpResponseError(step.status, step.body);
      case 'failure':
        throw new Error(step.message);
    }
  }
}
