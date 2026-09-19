/**
 * Human-readable CLI rendering (JG-023, specification 2.2, 4.2 and 4.5).
 *
 * Two rules shape this module:
 *
 * 1. The excerpt block is the original source slice. Nothing is re-indented, wrapped,
 *    summarized or re-ordered, so a reader can trust that the lines shown are the lines in
 *    the file.
 * 2. The human view budgets its own complete representation. Whole excerpts are
 *    removed and the complete text is recounted until it fits its independent limit.
 *
 * The renderer is pure: it returns text plus its measurements and writes nothing.
 *
 * The shared outcome type is an intersection of generated schema types, so a discriminant
 * check on `status` does not narrow it. The shapes are therefore separated structurally,
 * exactly as at the wire boundary: a result carries an excerpt array, a failure carries an
 * error. tests/contract (M's suite) is what guarantees the underlying payload shape.
 */
import type { Excerpt, SearchOutcome, SearchResult } from './contracts.ts';
import type { ResponseTokenCounter } from './search-response.ts';

export type RenderedHumanOutcome = {
  readonly text: string;
  readonly excerptCount: number;
  readonly tokenCount: number;
  readonly byteCount: number;
  readonly counter: string;
};

/** Heading and closing metadata stay short: the excerpts are the payload. */
const MAX_STOP_REASONS = 8;

type FailureView = {
  readonly status: string;
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryable?: boolean };
  readonly report?: {
    readonly scope?: readonly string[];
    readonly stop_reasons?: readonly string[];
  };
};

function asResult(outcome: SearchOutcome): SearchResult | undefined {
  const candidate = outcome as { readonly excerpts?: unknown };
  return Array.isArray(candidate.excerpts) ? (outcome as SearchResult) : undefined;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

function excerptHeading(excerpt: Excerpt): string {
  const score = typeof excerpt.score === 'number' ? ` score ${excerpt.score.toFixed(2)}` : ' score unavailable';
  return `${excerpt.path}:${String(excerpt.start_line)}-${String(excerpt.end_line)}${score}`;
}

function coverageLine(result: SearchResult): string {
  const { report } = result;
  const parts = [
    `scope ${report.scope.join(', ') || '.'}`,
    `files ${String(report.files.eligible)}/${String(report.files.discovered)} eligible`,
    `${report.fragments.total === null ? 'unknown total' : String(report.fragments.total)} fragments`,
    `coverage ${report.scope_fully_scanned ? 'complete' : 'incomplete'}`,
  ];
  return `coverage: ${parts.join(' | ')}`;
}

function failureLines(failure: FailureView): string[] {
  const lines = [`jevgrep: ${failure.status}`];
  lines.push(`error: ${failure.error?.code ?? 'UNKNOWN'}`);
  if (typeof failure.error?.message === 'string' && failure.error.message.length > 0) {
    lines.push(`detail: ${failure.error.message}`);
  }
  if (failure.error?.retryable === true) {
    lines.push('retryable: yes');
  }
  const reasons = failure.report?.stop_reasons ?? [];
  if (reasons.length > 0) {
    lines.push(`stop reasons: ${reasons.slice(0, MAX_STOP_REASONS).join(', ')}`);
  }
  if (failure.status === 'rejected') {
    lines.push('note: the request was refused; no repository content was evaluated');
  }
  return lines;
}

/**
 * Render one outcome for a human reader. The text is stable for a given outcome and counter,
 * so it can be compared and measured.
 */
export function renderHumanOutcome(
  outcome: SearchOutcome,
  counter: ResponseTokenCounter,
  maxTokens = asResult(outcome)?.report.response_budget.requested_tokens ?? 1_024,
): RenderedHumanOutcome {
  const lines: string[] = [];
  const result = asResult(outcome);

  if (result === undefined) {
    lines.push(...failureLines(outcome as FailureView));
  } else {
    lines.push(`jevgrep: ${result.status}`);
    lines.push(coverageLine(result));
    const reasons = result.report.stop_reasons.slice(0, MAX_STOP_REASONS);
    if (reasons.length > 0) {
      lines.push(`stop reasons: ${reasons.join(', ')}`);
    }
    if (result.status === 'partial') {
      lines.push('note: coverage is incomplete; an empty or short selection does not establish absence');
    }
  }

  const excerpts = [...(result?.excerpts ?? [])];
  const originalCount = excerpts.length;
  for (;;) {
    const body = [...lines, '', plural(excerpts.length, 'excerpt', 'excerpts')];
    if (excerpts.length < originalCount) {
      body.push(`${String(originalCount - excerpts.length)} excerpt(s) omitted to fit the human view budget`);
    }
    for (const excerpt of excerpts) body.push('', excerptHeading(excerpt), excerpt.code);
    body.push('', `human view: limit ${String(maxTokens)} reference tokens (${counter.id}); JSON is measured separately`);
    const text = `${body.join('\n')}\n`;
    const tokenCount = counter.count(text);
    if (tokenCount <= maxTokens) {
      return { text, excerptCount: excerpts.length, tokenCount, byteCount: Buffer.byteLength(text), counter: counter.id };
    }
    if (excerpts.length === 0) {
      throw new RangeError('RESPONSE_BUDGET_TOO_SMALL: the human report cannot fit its response budget');
    }
    excerpts.pop();
    // BPE token counts need not shrink monotonically: measure the whole text again.
  }
}
