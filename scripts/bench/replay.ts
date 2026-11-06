/**
 * Offline selection replay (roadmap sections 1 and 8, experiment E2).
 *
 * A captured pool holds every evaluated candidate of one live search with its saved
 * score. Replaying re-slices the same pinned source, checked by SHA-256, and runs only
 * local selection and rendering, so every arm sees identical candidates and scores and
 * no provider request is ever made.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SearchResult } from '../../src/contracts.ts';
import { CANDIDATE_POOL_VERSION } from '../../src/response/candidate-pool.ts';
import type { CandidatePool, PooledCandidate } from '../../src/response/candidate-pool.ts';
import { excerptBudget, excerptCost, renderSearchResult } from '../../src/response/render.ts';
import type { ReportInputs } from '../../src/response/render.ts';
import { selectRanges } from '../../src/response/selection.ts';
import type { SelectedRange, SelectionPolicy, SelectionTuning } from '../../src/response/selection.ts';
import type { PreparedFragment } from '../../src/source/chunker.ts';
import { writeReport } from './common.ts';
import { questions, validateDataset } from './dataset.ts';
import type { RetrievalQuestion } from './dataset.ts';
import { loadManifest } from './real-tasks.ts';
import type { LocalizationQuestion } from './retrieval.ts';
import { loadSnapshots } from './snapshots.ts';

/** One captured search: `source` names the fixture repository or real task it ran on. */
export type CapturedPool = { readonly id: string; readonly source: string; readonly pool: CandidatePool };

export type CaptureFile = {
  readonly schemaVersion: 1;
  readonly kind: 'candidate-pools';
  readonly capture: 'synthetic' | 'real' | 'false-premise';
  readonly dataset: string;
  readonly split?: string;
  readonly environment: unknown;
  readonly settings: unknown;
  readonly pools: readonly CapturedPool[];
};

export function writeCapture(output: string, capture: Omit<CaptureFile, 'schemaVersion' | 'kind' | 'capture'> & { kind: CaptureFile['capture'] }): string {
  const { kind, ...rest } = capture;
  return writeReport(output, { schemaVersion: 1, kind: 'candidate-pools', capture: kind, ...rest } satisfies CaptureFile);
}

export function readCapture(path: string): CaptureFile {
  const capture = JSON.parse(readFileSync(path, 'utf8')) as CaptureFile;
  if (capture.kind !== 'candidate-pools' || capture.schemaVersion !== 1) throw new Error(`${path} is not a candidate-pool capture`);
  for (const { id, pool } of capture.pools) {
    if (pool.version !== CANDIDATE_POOL_VERSION) throw new Error(`${id}: unsupported candidate-pool version ${String(pool.version)}`);
  }
  return capture;
}

/** One arm of the comparison; every field except `policy` defaults to the captured search. */
export type ReplayArm = {
  readonly policy: SelectionPolicy;
  readonly tuning?: Partial<SelectionTuning>;
  /** Whole-declaration return of split windows, as the engine does; false replays windows only. */
  readonly wholeDeclarations?: boolean;
  /** Response budget; the excerpt budget is derived exactly as in a live search. */
  readonly requestedTokens?: number;
  readonly threshold?: number;
  /** Return at most this many excerpts (calibration). */
  readonly topK?: number;
  /** Ignore candidates scoring more than this below the best candidate (calibration). */
  readonly scoreGap?: number;
};

export type ReplayResult = { readonly result: SearchResult; readonly measuredTokens: number };

type Lines = { readonly text: string; readonly starts: readonly number[] };

function lineIndex(text: string): Lines {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  if (starts.at(-1) === text.length && text.length > 0) starts.pop();
  return { text, starts };
}

/** Snapshots are UTF-8 sources; the same slicing rule as SourceSnapshot.sliceLines. */
function slice(lines: Lines, startLine: number, endLine: number): string {
  return lines.text.slice(lines.starts[startLine - 1], lines.starts[endLine] ?? lines.text.length);
}

/** Replays one pool against files keyed by repository-relative path. */
export function replayPool(pool: CandidatePool, files: Readonly<Record<string, string>>, arm: ReplayArm): ReplayResult {
  const indexes = new Map<string, Lines>();
  const lines = (candidate: Pick<PooledCandidate, 'path' | 'sha256'>): Lines => {
    let index = indexes.get(candidate.path);
    if (index === undefined) {
      const text = files[candidate.path];
      if (text === undefined) throw new Error(`${pool.searchId}: ${candidate.path} is missing from the replay source`);
      if (createHash('sha256').update(text, 'utf8').digest('hex') !== candidate.sha256) {
        throw new Error(`${pool.searchId}: ${candidate.path} does not match the captured snapshot`);
      }
      index = lineIndex(text);
      indexes.set(candidate.path, index);
    }
    return index;
  };
  const candidates = pool.candidates.map((entry) => {
    const text = slice(lines(entry), entry.startLine, entry.endLine);
    const fragment: PreparedFragment = {
      id: entry.id, path: entry.path, sha256: entry.sha256, startLine: entry.startLine, endLine: entry.endLine,
      byteStart: 0, byteEnd: Buffer.byteLength(text), text, byteCount: Buffer.byteLength(text), tokenCount: 0,
      chunker: entry.chunker, classification: entry.classification, label: entry.label,
      ...(entry.declaration == null ? {} : { declaration: entry.declaration }),
    };
    return { fragment, score: entry.score };
  });

  const best = Math.max(...candidates.map((entry) => entry.score), 0);
  const threshold = Math.max(arm.threshold ?? pool.threshold, arm.scoreGap === undefined ? 0 : best - arm.scoreGap);
  const requestedTokens = arm.requestedTokens ?? pool.requestedTokens;
  const availableTokens = arm.requestedTokens === undefined ? pool.availableTokens
    : excerptBudget(pool.searchId, pool.scope, pool.versions.counter, requestedTokens);
  const selection = selectRanges(candidates, {
    threshold, availableTokens, measure: excerptCost,
    sliceLines: (path, startLine, endLine) => {
      const text = files[path];
      return text === undefined ? null : slice(indexes.get(path) ?? lineIndex(text), startLine, endLine);
    },
    policy: arm.policy, ...(arm.tuning === undefined ? {} : { tuning: arm.tuning }),
    wholeDeclarations: arm.wholeDeclarations ?? true,
  });
  const ranges = arm.topK === undefined ? selection.ranges : topRanges(selection.ranges, arm.topK);
  const inputs: ReportInputs = {
    ...pool.inputs,
    fragments: {
      ...pool.inputs.fragments,
      belowThreshold: selection.belowThreshold, aboveThreshold: selection.aboveThreshold, omittedStale: selection.omittedUnavailable,
    },
    threshold, duplicateRangesCollapsed: selection.duplicateRangesCollapsed, requestedTokens,
  };
  const representedFor = (kept: readonly SelectedRange[]): number => candidates.filter(({ fragment, score }) => score >= threshold
    && kept.some((range) => range.path === fragment.path && range.startLine <= fragment.startLine && range.endLine >= fragment.endLine)).length;
  const rendered = renderSearchResult(inputs, ranges, representedFor);
  return { result: rendered.result, measuredTokens: rendered.measuredTokens };
}

function topRanges(ranges: readonly SelectedRange[], k: number): SelectedRange[] {
  const order = [...ranges].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
  const kept = new Set(order.slice(0, k));
  return ranges.filter((range) => kept.has(range));
}

export type ReplayQuery = LocalizationQuestion & { readonly id: string; readonly negative: boolean };
/** One captured search with its annotation and the pinned files it ran on. */
export type ReplayCase = { readonly id: string; readonly capture: string; readonly query: ReplayQuery; readonly files: Readonly<Record<string, string>>; readonly pool: CaptureFile['pools'][number]['pool'] };

export async function loadReplayCases(paths: readonly string[], mirrors: string): Promise<ReplayCase[]> {
  const cases: ReplayCase[] = [];
  const manifest = loadManifest();
  for (const path of paths) {
    const capture = readCapture(path);
    if (capture.capture === 'synthetic') {
      const repositories = validateDataset();
      for (const { id, source, pool } of capture.pools) {
        const question = questions.find((entry) => entry.id === id);
        if (question === undefined) throw new Error(`${id}: unknown synthetic question`);
        cases.push({ id, capture: 'synthetic', pool, files: repositories.get(source as RetrievalQuestion['repository'])!,
          query: { id, evidence: question.evidence, complementary: [], negative: question.kind === 'negative' } });
      }
    } else if (capture.capture === 'real') {
      const tasks = manifest.tasks.filter((task) => capture.pools.some((entry) => entry.source === task.id));
      const snapshots = await loadSnapshots(tasks, mirrors);
      for (const { id, source, pool } of capture.pools) {
        const query = tasks.find((task) => task.id === source)?.queries.find((entry) => entry.id === id);
        if (query === undefined) throw new Error(`${id}: unknown real query`);
        cases.push({ id, capture: `real-${capture.split ?? ''}`, pool, files: snapshots.get(source)!,
          query: { id, evidence: query.evidence, complementary: query.complementary, negative: query.evidence.length === 0 } });
      }
    } else {
      throw new Error(`${path}: ${capture.capture} pools carry no localization annotations`);
    }
  }
  return cases;
}
