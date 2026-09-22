import { ProviderError, type ProviderClient } from '../../src/evaluation/jev.ts';
import { countReferenceTokens } from '../../src/response/token-counter.ts';

/** Shared across all questions, including retries. Reservations happen before await. */
export function limitProvider(provider: ProviderClient, serialize: NonNullable<ProviderClient['serializeBatch']>,
  caps: { requests: number; estimatedInputTokens: number }) {
  const usage = { attempts: 0, reservedInputTokens: 0, reportedInputTokens: 0, unknownUsageAttempts: 0, blocked: false };
  const limited: ProviderClient = {
    model: provider.model, serializeBatch: serialize,
    async evaluateBatch(batch, signal) {
      const reservation = Math.max(1, countReferenceTokens(serialize(batch)));
      if (usage.attempts >= caps.requests || usage.reservedInputTokens + reservation > caps.estimatedInputTokens) {
        usage.blocked = true;
        throw new ProviderError({ code: 'PROVIDER_QUOTA', message: 'benchmark dispatch cap reached', retryable: false, ambiguous: false });
      }
      usage.attempts += 1;
      usage.reservedInputTokens += reservation;
      try {
        const result = await provider.evaluateBatch(batch, signal);
        if (result.usage.inputTokens === null) usage.unknownUsageAttempts += 1;
        else {
          usage.reportedInputTokens += result.usage.inputTokens;
          // Do not release conservative estimates; an unexpectedly higher reported
          // count consumes future capacity. These are input estimates, not a bill cap.
          usage.reservedInputTokens += Math.max(0, result.usage.inputTokens - reservation);
        }
        return result;
      } catch (cause) {
        usage.unknownUsageAttempts += 1;
        throw cause;
      }
    },
  };
  return { provider: limited, usage };
}
