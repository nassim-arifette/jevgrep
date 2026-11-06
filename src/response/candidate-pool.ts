/**
 * Captured candidate pools for offline selection experiments (roadmap section 1/8, E2).
 *
 * A pool is everything selection consumed in one search: the evaluated fragment
 * ranges with their saved scores, the report inputs rendered around them and the
 * versions that produced the scores. It carries no source text; a replay re-slices
 * the same snapshot, identified by its SHA-256, so arms compare identical inputs
 * without new provider calls.
 */
import type { ReportInputs } from './render.ts';

export const CANDIDATE_POOL_VERSION = 1;

export type PooledCandidate = {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly chunker: string;
  readonly classification: 'line-window' | 'syntax-range';
  readonly label: string | null;
  /** The declaration a split window was cut from; selection may return it whole. Absent in pools captured before it was recorded. */
  readonly declaration?: { readonly startLine: number; readonly endLine: number } | null;
};

export type CandidatePool = {
  readonly version: typeof CANDIDATE_POOL_VERSION;
  readonly searchId: string;
  readonly query: string;
  readonly scope: readonly string[];
  readonly versions: {
    readonly adapter: string;
    readonly model: string;
    readonly criterion: string;
    readonly layout: string;
    readonly counter: string;
  };
  readonly threshold: number;
  readonly requestedTokens: number;
  readonly availableTokens: number;
  readonly candidates: readonly PooledCandidate[];
  /** Report inputs of the captured search; selection-dependent counters are recomputed on replay. */
  readonly inputs: ReportInputs;
};
