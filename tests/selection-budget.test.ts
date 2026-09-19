import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { excerptBudget, excerptCost, mandatoryEnvelopeTokens, renderSearchResult, ResponseBudgetError } from '../src/response/render.ts';
import type { ReportInputs } from '../src/response/render.ts';
import { selectRanges } from '../src/response/selection.ts';
import type { Candidate, SelectedRange } from '../src/response/selection.ts';
import { countReferenceTokens, REFERENCE_COUNTER_ID } from '../src/response/token-counter.ts';
import type { PreparedFragment } from '../src/source/chunker.ts';

/**
 * Ranking, merging, budgeted selection and the measured response
 * (JG-019, with the rendering guarantee JG-020 owns).
 *
 * The properties under test come straight from specification 8.1 and 8.2: a stable
 * order independent of provider completion order, merging only inside one file
 * snapshot, an oversized candidate never blocking a smaller one, counters that stay
 * true after every removal, and a payload that fits its declared budget without
 * truncating anything.
 */

const FILES: Record<string, string> = {
  'src/cache.ts': Array.from({ length: 40 }, (_, index) => `const cacheLine${String(index)} = ${String(index)};`).join('\n') + '\n',
  'src/handler.ts': Array.from({ length: 40 }, (_, index) => `const handlerLine${String(index)} = ${String(index)};`).join('\n') + '\n',
  'src/copy.ts': Array.from({ length: 40 }, (_, index) => `const cacheLine${String(index)} = ${String(index)};`).join('\n') + '\n',
};

function sliceLines(path: string, startLine: number, endLine: number): string | null {
  const text = FILES[path];
  if (text === undefined) {
    return null;
  }
  const lines = text.split(/(?<=\n)/);
  return lines.slice(startLine - 1, endLine).join('');
}

/** Contract-shaped digests: the validator rightly refuses a placeholder hash. */
function digestFor(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fragment(path: string, startLine: number, endLine: number, sha = digestFor(path)): PreparedFragment {
  const text = sliceLines(path, startLine, endLine) ?? '';
  return {
    id: `${path}#L${String(startLine)}-L${String(endLine)}`,
    path,
    sha256: sha,
    startLine,
    endLine,
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    text,
    byteCount: Buffer.byteLength(text),
    tokenCount: countReferenceTokens(text),
    chunker: 'jevgrep-syntax-1',
    classification: 'syntax-range',
    label: null,
  };
}

function select(candidates: Candidate[], availableTokens = 10_000, threshold = 0.5): ReturnType<typeof selectRanges> {
  return selectRanges(candidates, { threshold, availableTokens, measure: excerptCost, sliceLines });
}

test('the order is stable under ties and independent of the order answers arrived in', () => {
  const candidates: Candidate[] = [
    { fragment: fragment('src/handler.ts', 1, 5), score: 0.8 },
    { fragment: fragment('src/cache.ts', 10, 14), score: 0.8 },
    { fragment: fragment('src/cache.ts', 1, 5), score: 0.8 },
  ];
  const forward = select(candidates);
  const reversed = select([...candidates].reverse());
  assert.deepEqual(
    forward.ranges.map((range) => `${range.path}:${String(range.startLine)}`),
    reversed.ranges.map((range) => `${range.path}:${String(range.startLine)}`),
  );
  assert.deepEqual(forward.ranges.map((range) => range.path), ['src/cache.ts', 'src/cache.ts', 'src/handler.ts']);
});

test('scores below the threshold are counted, never returned', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 5), score: 0.49 },
    { fragment: fragment('src/handler.ts', 1, 5), score: 0.51 },
  ]);
  assert.equal(result.belowThreshold, 1);
  assert.equal(result.aboveThreshold, 1);
  assert.deepEqual(result.ranges.map((range) => range.path), ['src/handler.ts']);
});

test('overlapping and adjacent ranges of one snapshot merge into one contiguous slice', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 10), score: 0.9 },
    { fragment: fragment('src/cache.ts', 8, 15), score: 0.7 },
    { fragment: fragment('src/cache.ts', 16, 20), score: 0.6 },
  ]);
  assert.equal(result.ranges.length, 1);
  const [range] = result.ranges;
  assert.ok(range !== undefined);
  assert.equal(range.startLine, 1);
  assert.equal(range.endLine, 20);
  assert.equal(range.score, 0.9, 'a merged range carries the maximum contributing score');
  assert.equal(range.text, sliceLines('src/cache.ts', 1, 20));
  assert.equal(result.representedFragments, 3);
});

test('two disjoint ranges are never presented as one excerpt', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 5), score: 0.9 },
    { fragment: fragment('src/cache.ts', 30, 34), score: 0.8 },
  ]);
  assert.equal(result.ranges.length, 2);
  assert.ok(result.ranges.every((range) => range.text === sliceLines(range.path, range.startLine, range.endLine)));
});

test('ranges of different files or different snapshots never merge', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 5, digestFor('old')), score: 0.9 },
    { fragment: fragment('src/cache.ts', 4, 8, digestFor('new')), score: 0.9 },
    { fragment: fragment('src/handler.ts', 1, 5), score: 0.9 },
  ]);
  assert.equal(result.ranges.length, 3);
});

test('identical text at two paths is preserved as two pieces of evidence', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 5), score: 0.9 },
    { fragment: fragment('src/copy.ts', 1, 5), score: 0.9 },
  ]);
  assert.equal(result.ranges.length, 2);
  assert.equal(result.duplicateRangesCollapsed, 0);
});

test('an exact duplicate range of one snapshot is collapsed once', () => {
  const result = select([
    { fragment: { ...fragment('src/cache.ts', 1, 5), id: 'first' }, score: 0.9 },
    { fragment: { ...fragment('src/cache.ts', 1, 5), id: 'second' }, score: 0.6 },
  ]);
  assert.equal(result.duplicateRangesCollapsed, 1);
  assert.equal(result.ranges.length, 1);
  assert.equal(result.ranges[0]?.score, 0.9);
  assert.equal(result.representedFragments, 2, 'both fragments are represented by the range that absorbed them');
});

test('an oversized candidate is skipped without blocking a smaller one behind it', () => {
  const big = fragment('src/cache.ts', 1, 40);
  const small = fragment('src/handler.ts', 1, 2);
  const available = excerptCost({
    path: small.path, sha256: small.sha256, startLine: small.startLine,
    endLine: small.endLine, score: 0.5, text: small.text,
  }) + 5;

  const result = select([
    { fragment: big, score: 0.95 },
    { fragment: small, score: 0.55 },
  ], available);

  assert.deepEqual(result.ranges.map((range) => range.path), ['src/handler.ts']);
  assert.equal(result.omittedByBudget, 1);
  assert.equal(result.representedFragments, 1);
  assert.equal(result.aboveThreshold, 2);
});

test('the three terminal categories always partition the qualifying fragments', () => {
  const result = select([
    { fragment: fragment('src/cache.ts', 1, 40), score: 0.9 },
    { fragment: fragment('src/handler.ts', 1, 40), score: 0.8 },
    { fragment: fragment('src/copy.ts', 1, 40), score: 0.7 },
  ], 400);
  assert.equal(
    result.representedFragments + result.omittedByBudget + result.omittedUnavailable,
    result.aboveThreshold,
  );
});

function reportInputs(overrides: Partial<ReportInputs> = {}): ReportInputs {
  return {
    searchId: 'render-case',
    scope: ['.'],
    inventoryComplete: true,
    files: { discovered: 3, eligible: 3, excludedByReason: {}, unreadable: 0, changedBeforeReturn: 0 },
    fragments: {
      total: 3, remoteEvaluated: 3, cacheReused: 0, notEvaluated: 0,
      belowThreshold: 0, aboveThreshold: 3, omittedStale: 0,
    },
    threshold: 0.5,
    duplicateRangesCollapsed: 0,
    usage: {
      providerRequestAttempts: 1, inputTokensKnownSubtotal: 500, inputTokensEstimated: 500,
      estimatedCostUsd: null, reportedCostUsd: null, attemptsWithUnknownUsage: 0,
      transmittedBytes: 1_024, elapsedMs: 42,
    },
    preflight: {
      plannedRemoteFragments: 3, plannedCacheHits: 0, estimatedFirstAttemptTokens: 500,
      estimatedFirstAttemptCostUsd: null, estimatedFirstAttemptRequests: 1,
      enabledCaps: {}, estimatedRequiredCaps: {},
    },
    requestedTokens: 4_000,
    counterId: REFERENCE_COUNTER_ID,
    stopReasons: [],
    diagnosticsTruncated: false,
    ...overrides,
  };
}

function rangesFor(paths: [string, number, number][]): SelectedRange[] {
  return paths.map(([path, startLine, endLine], index) => ({
    path, sha256: digestFor(path), startLine, endLine,
    score: 0.9 - index * 0.1,
    text: sliceLines(path, startLine, endLine) ?? '',
  }));
}

test('the mandatory envelope is reserved before any paid work', () => {
  const envelope = mandatoryEnvelopeTokens('render-case', ['.'], REFERENCE_COUNTER_ID);
  assert.ok(envelope > 0);
  assert.ok(excerptBudget('render-case', ['.'], REFERENCE_COUNTER_ID, 4_000) < 4_000);
  assert.throws(
    () => excerptBudget('render-case', ['.'], REFERENCE_COUNTER_ID, envelope),
    (error: unknown) => error instanceof ResponseBudgetError && error.requiredTokens >= envelope,
  );
});

test('the rendered payload fits its declared budget, code and metadata included', () => {
  const ranges = rangesFor([['src/cache.ts', 1, 40], ['src/handler.ts', 1, 40], ['src/copy.ts', 1, 40]]);
  const inputs = reportInputs({ requestedTokens: 1_500 });
  const rendered = renderSearchResult(inputs, ranges, (kept) => kept.length);

  assert.ok(rendered.measuredTokens <= 1_500);
  assert.equal(countReferenceTokens(rendered.text), rendered.measuredTokens);
  assert.ok(rendered.removedForBudget > 0, 'ranges were removed to fit');
  assert.equal(
    rendered.result.report.fragments.represented_in_response
    + rendered.result.report.fragments.omitted_by_response_budget
    + rendered.result.report.fragments.omitted_stale,
    rendered.result.report.fragments.above_threshold,
    'the omission counters were recomputed after each removal',
  );
  for (const excerpt of rendered.result.excerpts) {
    assert.equal(excerpt.code, sliceLines(excerpt.path, excerpt.start_line, excerpt.end_line));
  }
  assert.equal(JSON.parse(rendered.text) !== null, true, 'the payload stays valid JSON');
});

test('a full response never truncates a string, a line or a range', () => {
  const ranges = rangesFor([['src/cache.ts', 1, 40]]);
  const rendered = renderSearchResult(reportInputs({ requestedTokens: 2_000 }), ranges, (kept) => kept.length);
  for (const excerpt of rendered.result.excerpts) {
    assert.ok(excerpt.code.endsWith('\n') || excerpt.end_line === 40);
    assert.equal(excerpt.code, sliceLines(excerpt.path, excerpt.start_line, excerpt.end_line));
  }
});

test('an empty selection states why, following the documented precedence', () => {
  const noEligible = renderSearchResult(reportInputs({
    fragments: { total: 0, remoteEvaluated: 0, cacheReused: 0, notEvaluated: 0, belowThreshold: 0, aboveThreshold: 0, omittedStale: 0 },
    files: { discovered: 0, eligible: 0, excludedByReason: {}, unreadable: 0, changedBeforeReturn: 0 },
    preflight: {
      plannedRemoteFragments: 0, plannedCacheHits: 0, estimatedFirstAttemptTokens: 0,
      estimatedFirstAttemptCostUsd: null, estimatedFirstAttemptRequests: 0, enabledCaps: {}, estimatedRequiredCaps: {},
    },
    usage: {
      providerRequestAttempts: 0, inputTokensKnownSubtotal: 0, inputTokensEstimated: 0,
      estimatedCostUsd: null, reportedCostUsd: null, attemptsWithUnknownUsage: 0, transmittedBytes: 0, elapsedMs: 3,
    },
  }), [], () => 0);
  assert.equal(noEligible.result.report.selection.outcome, 'no_eligible_content');
  assert.equal(noEligible.result.status, 'complete');

  const belowThreshold = renderSearchResult(reportInputs({
    fragments: { total: 3, remoteEvaluated: 3, cacheReused: 0, notEvaluated: 0, belowThreshold: 3, aboveThreshold: 0, omittedStale: 0 },
  }), [], () => 0);
  assert.equal(belowThreshold.result.report.selection.outcome, 'no_score_above_threshold');
});
