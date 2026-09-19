/** Bounded provider work. The engine reserves every attempt before this seam sends it. */
import { SearchContext, isAbortError } from '../lifecycle.ts';
import { ProviderError, type BatchEvaluation, type EvaluationBatch, type ProviderClient } from './jev.ts';

export const DEFAULT_RETRY_POLICY = Object.freeze({
  max_retries: 2, base_delay_ms: 250, max_delay_ms: 5_000, retry_ambiguous: false,
});
export type RetryPolicy = {
  readonly max_retries: number; readonly base_delay_ms: number;
  readonly max_delay_ms: number; readonly retry_ambiguous: boolean;
};

export type EvaluationHandlers = {
  readonly concurrency: number;
  readonly retry?: RetryPolicy;
  readonly random?: () => number;
  readonly onDispatch?: (batch: EvaluationBatch) => boolean;
  readonly onScores: (batch: EvaluationBatch, evaluation: BatchEvaluation) => void;
  readonly onFailure: (batch: EvaluationBatch, failure: ProviderError, willRetry: boolean) => void;
};

/** Stop waiting even when an injected/failed transport ignores abort. Late results are discarded. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('provider wait aborted', 'AbortError'));
    };
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runEvaluations(
  provider: ProviderClient,
  batches: readonly EvaluationBatch[],
  context: SearchContext,
  handlers: EvaluationHandlers,
): Promise<void> {
  const retry = handlers.retry ?? DEFAULT_RETRY_POLICY;
  const random = handlers.random ?? Math.random;
  const controller = new AbortController();
  const waiting = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const waitSignal = AbortSignal.any([signal, waiting.signal]);
  let next = 0;
  let terminal = false;
  let cooldownUntil = 0;

  const pauseUntil = async (until: number): Promise<boolean> => {
    while (!terminal && context.canStartWork()) {
      const delay = Math.max(until, cooldownUntil) - context.clock.nowMs;
      if (delay <= 0) return true;
      try { await context.clock.sleep(Math.min(delay, context.remainingMs), waitSignal, { keepAlive: true }); }
      catch (cause) { if (!isAbortError(cause)) throw cause; return false; }
    }
    return false;
  };

  const worker = async (): Promise<void> => {
    while (next < batches.length && await pauseUntil(0)) {
      const batch = batches[next++];
      if (batch === undefined) return;
      for (let attempt = 0; ; attempt += 1) {
        if (terminal || !context.canStartWork() || signal.aborted) return;
        if (handlers.onDispatch?.(batch) === false) { terminal = true; waiting.abort(); return; }
        try {
          const evaluation = await abortable(provider.evaluateBatch(batch, signal), signal);
          // No score/cache write is accepted after a stop, even if abort was ignored.
          if (!context.canStartWork() || signal.aborted) throw new DOMException('provider wait aborted', 'AbortError');
          handlers.onScores(batch, evaluation);
          break;
        } catch (cause) {
          const failure = isAbortError(cause) ? new ProviderError({
            code: 'PROVIDER_UNAVAILABLE', message: 'evaluation aborted after possible dispatch',
            retryable: false, ambiguous: true, cancelled: signal.aborted,
          }) : cause;
          if (!(failure instanceof ProviderError)) throw failure;
          const fatal = failure.code === 'PROVIDER_AUTH' || failure.code === 'PROVIDER_QUOTA'
            || (failure.status !== null && failure.status >= 400 && failure.status < 500 && failure.status !== 429);
          if (fatal) { terminal = true; waiting.abort(); }
          const willRetry = !terminal && context.canStartWork() && !failure.cancelled
            && attempt < retry.max_retries && failure.retryable
            && (!failure.ambiguous || retry.retry_ambiguous);
          const backoff = Math.min(retry.max_delay_ms, retry.base_delay_ms * 2 ** attempt);
          const jittered = Math.round(backoff * (0.5 + Math.max(0, Math.min(1, random())) * 0.5));
          const delay = Math.max(jittered, failure.retryAfterMs ?? 0);
          if (failure.code === 'PROVIDER_RATE_LIMIT') cooldownUntil = Math.max(cooldownUntil, context.clock.nowMs + delay);
          handlers.onFailure(batch, failure, willRetry);
          if (!willRetry) break;
          if (!await pauseUntil(context.clock.nowMs + delay)) return;
        }
      }
    }
  };
  const count = Math.min(Math.max(1, handlers.concurrency), batches.length);
  try {
    await Promise.all(Array.from({ length: count }, () => worker().catch((cause: unknown) => {
      terminal = true;
      controller.abort();
      throw cause;
    })));
  } finally {
    waiting.abort();
    controller.abort();
  }
}
