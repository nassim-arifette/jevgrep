/**
 * Ranking, merging and budgeted selection (JG-019).
 *
 * The baseline of specification section 8.1: keep valid scores at or above the
 * threshold, rank them, collapse exact duplicates, merge overlapping or adjacent
 * ranges of the same file snapshot when the union fits, and skip what does not fit
 * without abandoning the smaller candidates behind it.
 *
 * Determinism is the point. Ties break on path, then start line, then end line, then
 * fragment id, so the provider's completion order can never change the answer. A
 * merged range carries the maximum contributing score and is explicitly a ranking
 * value, not extra certainty.
 *
 * This module never reads the filesystem and never re-renders source: it asks the
 * snapshot it was given for an exact slice of the union it wants to build. The final
 * serialized-budget guarantee belongs to JG-020, which may still remove ranges.
 */
import type { PreparedFragment } from '../source/chunker.ts';

export type Candidate = {
  readonly fragment: PreparedFragment;
  /** A validated probability; unavailable evaluations never reach this module. */
  readonly score: number;
};

export type SelectedRange = {
  readonly path: string;
  readonly sha256: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Maximum contributing score of the fragments inside this range. */
  readonly score: number;
  /** Exact snapshot slice of the whole range. */
  readonly text: string;
};

export type SelectionOptions = {
  readonly threshold: number;
  /** Tokens available for excerpts, after the mandatory report envelope is reserved. */
  readonly availableTokens: number;
  /** Cost of one range once serialized, as the pinned counter measures it. */
  readonly measure: (range: SelectedRange) => number;
  /** Exact slice of a file's line range; null when the file is no longer available. */
  readonly sliceLines: (path: string, startLine: number, endLine: number) => string | null;
  /** Files proven stale by JG-021; they are never selected again in this search. */
  readonly unavailablePaths?: ReadonlySet<string>;
};

export type SelectionResult = {
  readonly ranges: readonly SelectedRange[];
  readonly aboveThreshold: number;
  readonly belowThreshold: number;
  readonly duplicateRangesCollapsed: number;
  /** Qualifying fragments whose lines are all covered by a selected range. */
  readonly representedFragments: number;
  readonly omittedByBudget: number;
  /** Qualifying fragments dropped because their file is unavailable. */
  readonly omittedUnavailable: number;
};

type RankedCandidate = {
  readonly fragment: PreparedFragment;
  readonly score: number;
};

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.fragment.path !== right.fragment.path) {
    return left.fragment.path < right.fragment.path ? -1 : 1;
  }
  if (left.fragment.startLine !== right.fragment.startLine) {
    return left.fragment.startLine - right.fragment.startLine;
  }
  if (left.fragment.endLine !== right.fragment.endLine) {
    return left.fragment.endLine - right.fragment.endLine;
  }
  return left.fragment.id < right.fragment.id ? -1 : left.fragment.id > right.fragment.id ? 1 : 0;
}

/** Two ranges of one file snapshot that overlap or touch can become one slice. */
function touches(left: { startLine: number; endLine: number }, right: { startLine: number; endLine: number }): boolean {
  return left.startLine <= right.endLine + 1 && right.startLine <= left.endLine + 1;
}

/**
 * Rank and select ranges under an excerpt budget.
 *
 * Skipping an oversized candidate never stops the walk: a smaller, lower-ranked
 * candidate that still fits is selected (specification section 8.1, step 5).
 */
export function selectRanges(candidates: readonly Candidate[], options: SelectionOptions): SelectionResult {
  const unavailable = options.unavailablePaths ?? new Set<string>();
  const qualifying: RankedCandidate[] = [];
  let belowThreshold = 0;

  for (const candidate of candidates) {
    if (candidate.score >= options.threshold) {
      qualifying.push({ fragment: candidate.fragment, score: candidate.score });
    } else {
      belowThreshold += 1;
    }
  }

  // Exact duplicate ranges of one snapshot are one piece of evidence, kept once with
  // the strongest score. Identical text at another path is a different location and
  // is preserved.
  const byRange = new Map<string, RankedCandidate>();
  let duplicateRangesCollapsed = 0;
  for (const candidate of qualifying) {
    const key = `${candidate.fragment.path}\u0000${candidate.fragment.sha256}\u0000${String(candidate.fragment.startLine)}\u0000${String(candidate.fragment.endLine)}`;
    const existing = byRange.get(key);
    if (existing === undefined) {
      byRange.set(key, candidate);
      continue;
    }
    duplicateRangesCollapsed += 1;
    if (compareCandidates(candidate, existing) < 0) {
      byRange.set(key, candidate);
    }
  }

  const ranked = [...byRange.values()].sort(compareCandidates);
  const selected: SelectedRange[] = [];
  const unsliceable = new Set<string>();
  let usedTokens = 0;

  for (const candidate of ranked) {
    const { fragment } = candidate;
    if (unavailable.has(fragment.path)) {
      continue;
    }

    const neighbours = selected
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => range.path === fragment.path && range.sha256 === fragment.sha256 && touches(range, fragment));

    if (neighbours.length === 0) {
      const text = options.sliceLines(fragment.path, fragment.startLine, fragment.endLine);
      if (text === null) {
        unsliceable.add(fragment.path);
        continue;
      }
      const range: SelectedRange = {
        path: fragment.path, sha256: fragment.sha256,
        startLine: fragment.startLine, endLine: fragment.endLine,
        score: candidate.score, text,
      };
      const cost = options.measure(range);
      if (usedTokens + cost > options.availableTokens) {
        continue;
      }
      selected.push(range);
      usedTokens += cost;
      continue;
    }

    // Merge with every range it touches, so two selected ranges never end up
    // describing overlapping lines of the same snapshot.
    const startLine = Math.min(fragment.startLine, ...neighbours.map(({ range }) => range.startLine));
    const endLine = Math.max(fragment.endLine, ...neighbours.map(({ range }) => range.endLine));
    const text = options.sliceLines(fragment.path, startLine, endLine);
    if (text === null) {
      unsliceable.add(fragment.path);
      continue;
    }
    const merged: SelectedRange = {
      path: fragment.path, sha256: fragment.sha256, startLine, endLine,
      score: Math.max(candidate.score, ...neighbours.map(({ range }) => range.score)),
      text,
    };
    const replacedCost = neighbours.reduce((sum, { range }) => sum + options.measure(range), 0);
    const mergedCost = options.measure(merged);
    if (usedTokens - replacedCost + mergedCost > options.availableTokens) {
      continue;
    }
    const indexes = new Set(neighbours.map(({ index }) => index));
    const remaining = selected.filter((_, index) => !indexes.has(index));
    selected.length = 0;
    selected.push(...remaining, merged);
    usedTokens = usedTokens - replacedCost + mergedCost;
  }

  selected.sort((left, right) => (right.score - left.score)
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    || (left.startLine - right.startLine));

  // Terminal classification of every qualifying fragment, duplicates included:
  // represented, omitted for lack of response space, or omitted because its file is
  // unavailable. These three counts are what the contract's identity checks compare.
  let representedFragments = 0;
  let omittedByBudget = 0;
  let omittedUnavailable = 0;
  for (const candidate of qualifying) {
    const { fragment } = candidate;
    if (unavailable.has(fragment.path) || unsliceable.has(fragment.path)) {
      omittedUnavailable += 1;
      continue;
    }
    const covered = selected.some((range) => range.path === fragment.path
      && range.sha256 === fragment.sha256
      && range.startLine <= fragment.startLine
      && range.endLine >= fragment.endLine);
    if (covered) {
      representedFragments += 1;
    } else {
      omittedByBudget += 1;
    }
  }

  return {
    ranges: selected,
    aboveThreshold: qualifying.length,
    belowThreshold,
    duplicateRangesCollapsed,
    representedFragments,
    omittedByBudget,
    omittedUnavailable,
  };
}
