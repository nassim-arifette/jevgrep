/** Offline seams for recording every benchmark attempt, including retries and unknown usage. */
export type JudgeRequest = {
  readonly ids: readonly string[];
  readonly inputTokens: number | null;
  readonly cachedTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly bytes: number;
  readonly ms: number;
  readonly error: string | null;
  /** Optional only for reading reports produced before attempt accounting was added. */
  readonly attempt?: number;
  readonly status?: number | null;
  readonly requestedBackoffMs?: number;
  readonly backoffMs?: number;
};
export type JudgeReply = { readonly status: number; readonly raw: Record<string, unknown>; readonly error?: string };
export type JudgePrice = { readonly input: number; readonly cached: number; readonly output: number };

type Usage = {
  input_tokens?: unknown; output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
  output_tokens_details?: { reasoning_tokens?: unknown };
};

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function judgeWithRetries(options: {
  readonly ids: readonly string[];
  readonly bytes: number;
  readonly send: () => Promise<JudgeReply>;
  readonly parse: (raw: Record<string, unknown>) => ReadonlyMap<string, number>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}): Promise<{ scores: ReadonlyMap<string, number>; requests: JudgeRequest[] }> {
  const requests: JudgeRequest[] = [];
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be positive');
  let scores: ReadonlyMap<string, number> = new Map();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = options.now();
    let reply: JudgeReply | null = null;
    let error: string | null = null;
    try { reply = await options.send(); error = reply.error ?? null; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const ms = options.now() - started;
    const retryable = reply === null || reply.status === 429 || reply.status >= 500;
    const retry = retryable && attempt < maxAttempts;
    const usage = (reply?.raw['usage'] ?? {}) as Usage;
    const inputTokens = count(usage.input_tokens);
    let cachedTokens = count(usage.input_tokens_details?.cached_tokens);
    const outputTokens = count(usage.output_tokens);
    let reasoningTokens = count(usage.output_tokens_details?.reasoning_tokens);
    if (inputTokens !== null && cachedTokens !== null && cachedTokens > inputTokens) cachedTokens = null;
    if (outputTokens !== null && reasoningTokens !== null && reasoningTokens > outputTokens) reasoningTokens = null;
    if (reply !== null && reply.status === 200 && error === null) {
      try { scores = options.parse(reply.raw); }
      catch (cause) { error = `unparsable answer: ${String(cause)}`; }
      if (error === null && scores.size < options.ids.length) error = `missing answers: ${String(options.ids.length - scores.size)}`;
    } else if (error === null) {
      error = `HTTP ${String(reply?.status)}: ${JSON.stringify(reply?.raw['error'] ?? null).slice(0, 300)}`;
    }
    const requestedBackoffMs = retry ? 3_000 * attempt : 0;
    // Retain the attempt before sleeping or starting another one, even when the reply failed.
    const record = { ids: options.ids, inputTokens, cachedTokens, outputTokens, reasoningTokens,
      bytes: options.bytes, ms, error, attempt, status: reply?.status ?? null, requestedBackoffMs, backoffMs: 0 };
    requests.push(record);
    if (!retry) break;
    const backoffStarted = options.now();
    await options.sleep(requestedBackoffMs);
    record.backoffMs = options.now() - backoffStarted;
  }
  return { scores, requests };
}

/** Known amounts remain subtotals; unknown billable usage makes the full cost unknown. */
export function summarizeJudgeUsage(requests: readonly JudgeRequest[], price?: JudgePrice) {
  const sum = (pick: (request: JudgeRequest) => number | null | undefined): number =>
    requests.reduce((total, request) => total + (pick(request) ?? 0), 0);
  let knownUsd = 0;
  let unknownCostAttempts = 0;
  for (const request of requests) {
    if (price === undefined) continue;
    const input = request.inputTokens;
    const cached = request.cachedTokens;
    const output = request.outputTokens;
    const inputCost = price.input === 0 && price.cached === 0 ? 0 : input == null ? null
      : price.input === price.cached ? input * price.input
        : cached == null ? null : (input - cached) * price.input + cached * price.cached;
    const outputCost = price.output === 0 ? 0 : output == null ? null : output * price.output;
    knownUsd += ((inputCost ?? 0) + (outputCost ?? 0)) / 1e6;
    if (inputCost === null || outputCost === null) unknownCostAttempts += 1;
  }
  return {
    inputTokens: sum((request) => request.inputTokens), cachedTokens: sum((request) => request.cachedTokens),
    outputTokens: sum((request) => request.outputTokens), reasoningTokens: sum((request) => request.reasoningTokens),
    unknownInputUsageAttempts: requests.filter((request) => request.inputTokens == null).length,
    unknownCachedUsageAttempts: requests.filter((request) => request.cachedTokens == null).length,
    unknownOutputUsageAttempts: requests.filter((request) => request.outputTokens == null).length,
    unknownReasoningUsageAttempts: requests.filter((request) => request.reasoningTokens == null).length,
    unknownUsageAttempts: requests.filter((request) => request.inputTokens == null || request.outputTokens == null || request.cachedTokens == null).length,
    unknownCostAttempts,
    knownUsd: price === undefined ? null : knownUsd,
    usd: price === undefined || unknownCostAttempts > 0 ? null : knownUsd,
    backoffMs: sum((request) => request.backoffMs),
    attemptedBytes: sum((request) => request.bytes),
  };
}

/** Legacy timings omit preparation, unrecorded retries and backoff, so remain labeled lower bounds. */
export function judgeCaseTiming(entry: { readonly requests: readonly JudgeRequest[]; readonly wallMs?: number }) {
  if (entry.wallMs !== undefined) return { ms: entry.wallMs, source: 'wall' as const };
  return { ms: entry.requests.reduce((total, request) => total + request.ms + (request.backoffMs ?? 0), 0), source: 'recorded-attempts-lower-bound' as const };
}
