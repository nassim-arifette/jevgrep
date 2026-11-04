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
import { SELECTION_POLICIES } from '../contracts.ts';
import type { SelectionPolicy } from '../contracts.ts';
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
  /** Order in which qualifying candidates are offered to the budget; `relevance` is the default. */
  readonly policy?: SelectionPolicy;
  /** Experimental knobs of the non-default policies; never changes `relevance`. */
  readonly tuning?: Partial<SelectionTuning>;
  /** Under `relevance`, a qualifying window of a split declaration returns the whole declaration when it fits, itself otherwise. */
  readonly wholeDeclarations?: boolean;
};

/**
 * `relevance` walks candidates by descending score (specification section 8.1).
 * `mmr` (Goldstein and Carbonell, 1998) and `marginal` (score times novelty per added
 * serialized token) re-rank after every admission using local redundancy signals only:
 * overlapping lines, a shared structural label and lexical similarity. Both are
 * experiments behind an explicit option (roadmap section 8, E2); neither changes which
 * candidates qualify, the threshold, or the final presentation order.
 */
export { SELECTION_POLICIES };
export type { SelectionPolicy };

export type SelectionTuning = {
  /** MMR trade-off: 1 is pure relevance, 0 pure novelty. */
  readonly mmrLambda: number;
  /** How much redundancy discounts a candidate's value under `marginal` (0 to 1). */
  readonly redundancyWeight: number;
  /** Exponent on the added serialized tokens under `marginal`; 0 ignores cost. */
  readonly costExponent: number;
};

export const DEFAULT_SELECTION_TUNING: SelectionTuning = Object.freeze({
  mmrLambda: 0.7,
  redundancyWeight: 1,
  costExponent: 0.5,
});

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

/** What admitting one candidate would do, computed before anything is committed. */
type Admission = {
  readonly range: SelectedRange;
  /** Indexes of the selected ranges the new range replaces (empty for a new range). */
  readonly replaces: readonly number[];
  /** Change in the measured excerpt cost; merging can make it zero or negative. */
  readonly delta: number;
};

/** Selected ranges, their measured cost and the merge rules shared by every policy. */
class RangeSet {
  readonly selected: SelectedRange[] = [];
  readonly unsliceable = new Set<string>();
  usedTokens = 0;
  readonly #options: SelectionOptions;

  constructor(options: SelectionOptions) {
    this.#options = options;
  }

  /** null when the file can no longer be sliced; the caller records it as unavailable. */
  plan(candidate: RankedCandidate, wholeDeclaration = false): Admission | null {
    const { fragment } = candidate;
    const span = wholeDeclaration && fragment.declaration != null ? fragment.declaration : fragment;
    const neighbours: number[] = [];
    this.selected.forEach((range, index) => {
      if (range.path === fragment.path && range.sha256 === fragment.sha256 && touches(range, span)) neighbours.push(index);
    });
    const ranges = neighbours.map((index) => this.selected[index]!);
    // Merge with every range it touches, so two selected ranges never end up
    // describing overlapping lines of the same snapshot.
    const startLine = Math.min(span.startLine, ...ranges.map((range) => range.startLine));
    const endLine = Math.max(span.endLine, ...ranges.map((range) => range.endLine));
    const text = this.#options.sliceLines(fragment.path, startLine, endLine);
    if (text === null) {
      return null;
    }
    const range: SelectedRange = {
      path: fragment.path, sha256: fragment.sha256, startLine, endLine,
      score: Math.max(candidate.score, ...ranges.map((entry) => entry.score)),
      text,
    };
    const replacedCost = ranges.reduce((sum, entry) => sum + this.#options.measure(entry), 0);
    return { range, replaces: neighbours, delta: this.#options.measure(range) - replacedCost };
  }

  fits(admission: Admission): boolean {
    return this.usedTokens + admission.delta <= this.#options.availableTokens;
  }

  commit(admission: Admission): void {
    if (admission.replaces.length === 0) {
      this.selected.push(admission.range);
    } else {
      const indexes = new Set(admission.replaces);
      const remaining = this.selected.filter((_, index) => !indexes.has(index));
      this.selected.length = 0;
      this.selected.push(...remaining, admission.range);
    }
    this.usedTokens += admission.delta;
  }
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

  const ranked = [...byRange.values()].sort(compareCandidates).filter((candidate) => !unavailable.has(candidate.fragment.path));
  const set = new RangeSet(options);
  const policy = options.policy ?? 'relevance';
  if (policy === 'relevance') {
    const wholeDeclarations = options.wholeDeclarations === true;
    for (const candidate of ranked) {
      // A window cut from a long declaration offers the whole declaration first and
      // falls back to itself when the declaration does not fit.
      const whole = wholeDeclarations && candidate.fragment.declaration != null ? set.plan(candidate, true) : null;
      const admission = whole !== null && set.fits(whole) ? whole : set.plan(candidate);
      if (admission === null) {
        set.unsliceable.add(candidate.fragment.path);
      } else if (set.fits(admission)) {
        set.commit(admission);
      }
    }
  } else {
    selectGreedy(ranked, set, policy, { ...DEFAULT_SELECTION_TUNING, ...options.tuning });
  }
  const { selected, unsliceable } = set;

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

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]+/g;

function identifiers(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(IDENTIFIER), (match) => match[0].toLowerCase()));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

type Profile = { readonly words: Set<string>; readonly labels: ReadonlySet<string> };

/**
 * Local redundancy of a candidate against one selected range, in [0, 1]: the
 * fraction of its lines already covered, a shared structural label in the same
 * file, or identifier-set similarity anywhere. Touching without overlap is
 * contiguous context, not redundancy.
 */
function redundancy(candidate: RankedCandidate, words: ReadonlySet<string>, range: SelectedRange, profile: Profile): number {
  const { fragment } = candidate;
  let value = jaccard(words, profile.words);
  if (range.path === fragment.path && range.sha256 === fragment.sha256) {
    const overlap = Math.min(range.endLine, fragment.endLine) - Math.max(range.startLine, fragment.startLine) + 1;
    if (overlap > 0) value = Math.max(value, overlap / (fragment.endLine - fragment.startLine + 1));
    if (fragment.label != null && profile.labels.has(fragment.label)) value = Math.max(value, 0.5);
  }
  return value;
}

/** Re-ranks after every admission; every candidate is offered until none fits. */
function selectGreedy(ranked: readonly RankedCandidate[], set: RangeSet, policy: Exclude<SelectionPolicy, 'relevance'>, tuning: SelectionTuning): void {
  type Entry = { candidate: RankedCandidate; words: Set<string>; redundancy: number; admission: Admission | null | undefined };
  const entries: Entry[] = ranked.map((candidate) => ({
    candidate, words: identifiers(candidate.fragment.text), redundancy: 0, admission: undefined,
  }));
  const profiles = new Map<SelectedRange, Profile>();
  const value = (entry: Entry, admission: Admission): number => {
    const { score } = entry.candidate;
    if (policy === 'mmr') return tuning.mmrLambda * score - (1 - tuning.mmrLambda) * entry.redundancy;
    const novelty = Math.max(0, 1 - tuning.redundancyWeight * entry.redundancy);
    return score * novelty / Math.max(1, admission.delta) ** tuning.costExponent;
  };

  for (;;) {
    let best: { entry: Entry; admission: Admission; value: number } | null = null;
    for (const entry of entries) {
      if (entry.admission === undefined) {
        entry.admission = set.plan(entry.candidate);
        if (entry.admission === null) set.unsliceable.add(entry.candidate.fragment.path);
      }
      const { admission } = entry;
      if (admission === null || !set.fits(admission)) continue;
      const score = value(entry, admission);
      // `entries` is in relevance order, so a strict comparison keeps its tie-breaks.
      if (best === null || score > best.value) best = { entry, admission, value: score };
    }
    if (best === null) return;

    set.commit(best.admission);
    entries.splice(entries.indexOf(best.entry), 1);
    const range = best.admission.range;
    const replaced = best.admission.replaces.length === 0 ? [] : [...profiles.keys()].filter((key) => !set.selected.includes(key));
    const labels = new Set(replaced.flatMap((key) => [...profiles.get(key)!.labels]));
    if (best.entry.candidate.fragment.label != null) labels.add(best.entry.candidate.fragment.label);
    for (const key of replaced) profiles.delete(key);
    const profile = { words: identifiers(range.text), labels };
    profiles.set(range, profile);
    for (const entry of entries) {
      // A commit only changes the merge plans of candidates in the same file.
      if (entry.candidate.fragment.path === range.path) entry.admission = undefined;
      entry.redundancy = Math.max(entry.redundancy, redundancy(entry.candidate, entry.words, range, profile));
    }
  }
}
