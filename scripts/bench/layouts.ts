/**
 * Experiment for roadmap section 11: compact Jev request layouts.
 *
 * Every captured candidate of the E2/E8 pools is judged again live under each layout
 * on identical chunks, so layouts differ only in how the request is written. The
 * captured scores are a second layout-A sample: their distance to the layout-A rerun
 * is the noise floor a compact layout has to stay within.
 */
import type { BatchItem, EvaluationBatch, RequestLayout } from '../../src/evaluation/contracts.ts';
import type { Case } from './criteria.ts';
import { replayPool } from './replay.ts';
import { localizationRangeMetrics } from './retrieval.ts';
import type { Evidence } from './dataset.ts';
import type { Range } from './retrieval.ts';

export { REQUEST_LAYOUTS as LAYOUT_ARMS } from '../../src/evaluation/jev.ts';

/**
 * Greedy, order-preserving chunks that fit under the layout-A envelope (the largest),
 * so every layout sends the same excerpts together. A lone item that does not fit is
 * kept alone; the provider limit, not this planner, decides it.
 */
export function planChunks(
  query: string, items: readonly BatchItem[], serialize: (batch: EvaluationBatch) => string, fits: (body: string) => boolean,
): BatchItem[][] {
  const chunks: BatchItem[][] = [];
  let current: BatchItem[] = [];
  for (const item of items) {
    const next = [...current, item];
    if (current.length > 0 && !fits(serialize({ query, items: next }))) {
      chunks.push(current);
      current = [item];
    } else current = next;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type LayoutRequest = { readonly ids: readonly string[]; readonly inputTokens: number | null; readonly bytes: number; readonly ms: number; readonly error: string | null };
export type LayoutJudgments = { readonly id: string; readonly scores: Readonly<Record<string, number>>; readonly requests: readonly LayoutRequest[] };
export type LayoutFile = {
  readonly schemaVersion: 1;
  readonly kind: 'layout-judgments';
  readonly layout: RequestLayout;
  readonly cases: readonly LayoutJudgments[];
  readonly [key: string]: unknown;
};

const overlaps = (unit: Evidence, excerpt: Range): boolean =>
  excerpt.path === unit.path && excerpt.start_line <= unit.endLine && excerpt.end_line >= unit.startLine;

export type LayoutRow = ReturnType<typeof scoreCase>;

/** Replay the default selection of one case with another score per candidate; a missing score makes the case incomplete. */
export function scoreCase(entry: Case, scores: Readonly<Record<string, number>> | null) {
  const missing = scores === null ? 0 : entry.pool.candidates.filter((candidate) => scores[candidate.id] === undefined).length;
  const candidates = entry.pool.candidates.map((candidate) => ({ ...candidate, score: scores?.[candidate.id] ?? candidate.score }));
  const { result, measuredTokens } = replayPool({ ...entry.pool, candidates }, entry.files, { policy: 'relevance' });
  const complete = missing === 0 && result.status === 'complete' && result.report.scope_fully_scanned;
  const excerpts = result.excerpts;
  const annotated = [...entry.evidence, ...entry.complementary];
  return {
    id: entry.id, group: entry.group, kind: entry.kind, complete, missing, measuredTokens,
    excerpts: excerpts.length,
    unannotated: excerpts.filter((excerpt) => !annotated.some((unit) => overlaps(unit, excerpt))).length,
    negativeCorrect: complete && entry.kind === 'negative' ? excerpts.length === 0 : null,
    metrics: !complete || entry.kind === 'negative' ? null : localizationRangeMetrics(entry, excerpts),
    scores: candidates.map((candidate) => candidate.score),
  };
}
