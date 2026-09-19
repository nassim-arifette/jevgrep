import { CONTRACT_LIMITS, searchOutcomeSchema } from './contracts.ts';
import type { SearchOutcome } from './contracts.ts';
import { requireContract } from './contract-schema.ts';

export const CLI_EXIT_CODES = Object.freeze({ complete: 0, rejected: 2, partial: 3, error: 4, interrupted: 130 });

/** JG-006 supplies the pinned reference tokenizer; this contract invents no tokenizer. */
export type ResponseTokenCounter = { readonly id: string; readonly count: (serialized: string) => number };

function renderedOutcome(input: unknown, counter: ResponseTokenCounter): { outcome: SearchOutcome; text: string } {
  const outcome = searchOutcomeSchema.parse(input);
  const text = JSON.stringify(outcome);
  const budget = 'report' in outcome ? outcome.report.response_budget.requested_tokens : CONTRACT_LIMITS.error_tokens;
  if ('report' in outcome) {
    requireContract(counter.id === outcome.report.response_budget.counter, '$.report.response_budget.counter', 'reference counter identity mismatch');
  }
  const tokens = counter.count(text);
  requireContract(Number.isSafeInteger(tokens) && tokens >= 0, '$', 'invalid reference-token count');
  requireContract(tokens <= budget, '$', 'serialized response exceeds its reference-token budget');
  return { outcome, text };
}

export function toCliSearchResponse(input: unknown, counter: ResponseTokenCounter): { stdout: string; exitCode: number } {
  const { outcome, text } = renderedOutcome(input, counter);
  const cancelled = 'error' in outcome ? outcome.error.code === 'CANCELLED' : outcome.report.stop_reasons.includes('CANCELLED');
  return { stdout: text, exitCode: cancelled ? CLI_EXIT_CODES.interrupted : CLI_EXIT_CODES[outcome.status] };
}

/** The MCP lifecycle must suppress this call after client cancellation (JG-009/024). */
export function toMcpSearchResponse(input: unknown, counter: ResponseTokenCounter): {
  content: [{ type: 'text'; text: string }]; isError: boolean;
} {
  const { outcome, text } = renderedOutcome(input, counter);
  return { content: [{ type: 'text', text }], isError: outcome.status === 'rejected' || outcome.status === 'error' };
}
