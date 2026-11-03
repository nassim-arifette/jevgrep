/**
 * First-stage candidate suppliers and a replay provider for roadmap section 9 (E4/E5).
 *
 * The suppliers only rank files that the full authorized scan prepared, so a candidate
 * list never widens authorization. `PoolProvider` answers the real engine with the
 * scores captured during that full scan, so a scoped search sees the same Jev
 * judgments as the full scan and makes no provider request.
 */
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../../src/evaluation/contracts.ts';
import type { CandidatePool } from '../../src/response/candidate-pool.ts';
import { bm25Scores, terms } from './lexical.ts';

/** BM25 (k1 = 1.2, b = 0.75) over whole files, as a lexical first stage would rank them. */
export function lexicalFiles(query: string, files: Readonly<Record<string, string>>, paths: readonly string[], limit: number): string[] {
  const scores = bm25Scores(paths.map((path) => terms(`${path} ${files[path] ?? ''}`)), query);
  return paths.map((path, index) => ({
    path,
    score: scores[index]!,
  })).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, limit).map((entry) => entry.path);
}

/**
 * Files an external tool or the question itself points at: paths in links, stack
 * traces or prose, resolved by suffix against the prepared files in order of mention.
 * A bare basename only resolves when it names exactly one file.
 */
export function mentionedFiles(query: string, paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const [token] of query.matchAll(/[\w./-]*\w\.[A-Za-z]\w*/g)) {
    const mention = token.replace(/^\.?\//, '');
    let matches = paths.filter((path) => mention === path || mention.endsWith(`/${path}`) || (mention.includes('/') && path.endsWith(`/${mention}`)));
    if (matches.length === 0 && !mention.includes('/')) {
      const named = paths.filter((path) => path === mention || path.endsWith(`/${mention}`));
      if (named.length === 1) matches = named;
    }
    for (const path of matches) if (!found.includes(path)) found.push(path);
  }
  return found;
}

/** Files that produced at least one evaluated fragment in the full authorized scan. */
export function preparedPaths(pool: CandidatePool): string[] {
  return [...new Set(pool.candidates.map((candidate) => candidate.path))].sort();
}

const key = (path: string, startLine: number, endLine: number): string => `${path}\0${String(startLine)}\0${String(endLine)}`;

/**
 * Replays the full scan's saved scores. A fragment the full scan did not evaluate is a
 * fidelity failure, not something to score, so it throws. Usage is reported unknown,
 * which makes the engine account for it with its own preflight estimate.
 */
export class PoolProvider implements ProviderClient {
  readonly model: string;
  readonly #scores: Map<string, number>;
  readonly #serialize: (batch: EvaluationBatch) => string;
  requests = 0;

  constructor(pool: CandidatePool, model: string, serialize: (batch: EvaluationBatch) => string) {
    this.model = model;
    this.#serialize = serialize;
    this.#scores = new Map(pool.candidates.map((candidate) => [key(candidate.path, candidate.startLine, candidate.endLine), candidate.score]));
  }

  serializeBatch(batch: EvaluationBatch): string {
    return this.#serialize(batch);
  }

  evaluateBatch(batch: EvaluationBatch, _signal?: AbortSignal, preparedBody?: string): Promise<BatchEvaluation> {
    this.requests += 1;
    const scores = new Map(batch.items.map((item) => {
      const score = this.#scores.get(key(item.path, item.startLine, item.endLine));
      if (score === undefined) throw new Error(`${item.path}:${String(item.startLine)}-${String(item.endLine)} was not evaluated by the captured full scan`);
      return [item.id, score] as const;
    }));
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: null, outputTokens: null }, requestedModel: this.model, returnedModel: null,
      transmittedBytes: Buffer.byteLength(preparedBody ?? this.#serialize(batch)), requestId: null,
    });
  }
}
