import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CorpusValidationError, scoreQuestion, validateManifest,
} from '../benchmarks/tools/corpus-scoring.ts';
import type { CorpusQuestion, EvidenceAnnotation, ReturnedRange } from '../benchmarks/tools/corpus-scoring.ts';

/**
 * Corpus validation and evidence scoring (JG-028, after review).
 *
 * The review asked for three things the first runner did not do: validate the manifest
 * it is about to measure, score *evidence sets* rather than loose overlaps, and keep
 * alternatives, ambiguity and no-evidence controls apart. These tests pin all three,
 * against the semantics JG-027's own checker enforces (`direct`, `supporting`,
 * `context`; `behavior`, `symbol_control`, `no_evidence`).
 */
const manifestDirectory = fileURLToPath(new URL('../benchmarks/manifests/development/', import.meta.url));

function evidence(path: string, start: number, end: number, role: EvidenceAnnotation['role'] = 'direct'): EvidenceAnnotation {
  return { path, start_line: start, end_line: end, role };
}

function question(overrides: Partial<CorpusQuestion> = {}): CorpusQuestion {
  return {
    id: 'fixture.development.001',
    kind: 'behavior',
    question: 'Where is the cache invalidated?',
    scope: ['src'],
    expected_evidence: [evidence('src/cache.ts', 10, 20)],
    ...overrides,
  };
}

function range(path: string, startLine: number, endLine: number): ReturnedRange {
  return { path, startLine, endLine };
}

test('every committed development manifest validates', () => {
  const files = readdirSync(manifestDirectory).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, 'the development split must contain manifests');
  for (const file of files) {
    const path = `${manifestDirectory}${file}`;
    const manifest = validateManifest(JSON.parse(readFileSync(path, 'utf8')), path);
    assert.equal(manifest.split, 'development');
    assert.ok(manifest.questions.length > 0);
  }
});

test('a manifest the runner cannot interpret is refused, never partially measured', () => {
  const base = JSON.parse(readFileSync(
    `${manifestDirectory}${readdirSync(manifestDirectory).filter((name) => name.endsWith('.json')).sort()[0] ?? ''}`,
    'utf8',
  )) as Record<string, unknown>;

  const cases: [string, unknown][] = [
    ['not an object', 42],
    ['wrong schema version', { ...base, schema_version: 2 }],
    ['unknown split', { ...base, split: 'production' }],
    ['budget below the contract minimum', { ...base, budget: { max_context_tokens: 10, allow_partial_scan: false } }],
    ['no questions', { ...base, questions: [] }],
    ['duplicate question ids', { ...base, questions: [question(), question()] }],
    ['unknown question kind', { ...base, questions: [{ ...question(), kind: 'trivia' }] }],
    ['unknown evidence role', { ...base, questions: [{ ...question(), expected_evidence: [{ ...evidence('src/a.ts', 1, 2), role: 'vibes' }] }] }],
    ['absolute evidence path', { ...base, questions: [{ ...question(), expected_evidence: [evidence('/etc/passwd', 1, 2)] }] }],
    ['traversing scope', { ...base, questions: [{ ...question(), scope: ['../other'] }] }],
    ['inverted line range', { ...base, questions: [{ ...question(), expected_evidence: [evidence('src/a.ts', 9, 3)] }] }],
    ['behavior without evidence', { ...base, questions: [question({ expected_evidence: [] })] }],
    ['context-only evidence', { ...base, questions: [question({ expected_evidence: [evidence('a.ts', 1, 2, 'context')] })] }],
    ['empty alternative', { ...base, questions: [question({ alternative_evidence_sets: [[]] })] }],
    ['negative control with evidence', { ...base, questions: [question({ kind: 'no_evidence' })] }],
    ['unexplained ambiguity', { ...base, questions: [question({ ambiguous: true })] }],
  ];

  for (const [label, candidate] of cases) {
    assert.throws(
      () => validateManifest(candidate, 'case.json'),
      (error: unknown) => error instanceof CorpusValidationError,
      `${label} must be refused`,
    );
  }
});

test('a set counts as complete only when every direct and supporting item is found', () => {
  const subject = question({
    expected_evidence: [
      evidence('src/cache.ts', 10, 20, 'direct'),
      evidence('src/handler.ts', 1, 5, 'supporting'),
    ],
  });

  const partial = scoreQuestion(subject, [range('src/cache.ts', 8, 15)]);
  assert.equal(partial.category, 'scored');
  assert.equal(partial.evidence_found, 1);
  assert.equal(partial.complete_set_found, false, 'half a set is not a complete answer');
  assert.equal(partial.direct_set_found, false, 'a partial line overlap does not cover the direct annotation');

  const whole = scoreQuestion(subject, [range('src/cache.ts', 8, 20), range('src/handler.ts', 1, 5)]);
  assert.equal(whole.complete_set_found, true);
  assert.equal(whole.evidence_found, 2);
});

test('context ranges are counted but never required for completeness', () => {
  const subject = question({
    expected_evidence: [
      evidence('src/cache.ts', 10, 20, 'direct'),
      evidence('docs/notes.md', 1, 4, 'context'),
    ],
  });

  const withoutContext = scoreQuestion(subject, [range('src/cache.ts', 10, 20)]);
  assert.equal(withoutContext.complete_set_found, true, 'background is not part of the obligation');
  assert.equal(withoutContext.context_items, 1);
  assert.equal(withoutContext.context_found, 0);

  const withContext = scoreQuestion(subject, [range('src/cache.ts', 10, 20), range('docs/notes.md', 2, 2)]);
  assert.equal(withContext.context_found, 1);
});

test('an alternative set is a different valid answer, not a larger obligation', () => {
  const subject = question({
    expected_evidence: [evidence('src/scheduler.ts', 11, 13)],
    alternative_evidence_sets: [[
      evidence('docs/operations.md', 3, 5, 'direct'),
      evidence('src/scheduler.ts', 11, 13, 'supporting'),
    ]],
  });

  const primary = scoreQuestion(subject, [range('src/scheduler.ts', 10, 14)]);
  assert.equal(primary.best_set, 0);
  assert.equal(primary.complete_set_found, true);
  assert.equal(primary.evidence_items, 1, 'the denominator is the matched set, not the union');

  const alternative = scoreQuestion(subject, [range('docs/operations.md', 3, 5), range('src/scheduler.ts', 11, 13)]);
  assert.equal(alternative.best_set, 1, 'the best matching set is the one that was answered');
  assert.equal(alternative.complete_set_found, true);
  assert.equal(alternative.set_count, 2);
});

test('an ambiguous question is scored but kept out of the headline population', () => {
  const subject = question({ ambiguous: true });
  const score = scoreQuestion(subject, [range('src/cache.ts', 10, 20)]);
  assert.equal(score.category, 'ambiguous');
  assert.equal(score.complete_set_found, true, 'it is still measured, just reported apart');
});

test('a no-evidence question is a negative control: an empty selection is the right answer', () => {
  const control = question({ kind: 'no_evidence', expected_evidence: [] });

  const empty = scoreQuestion(control, []);
  assert.equal(empty.category, 'no_evidence_control');
  assert.equal(empty.complete_set_found, true);
  assert.equal(empty.evidence_items, 0, 'a control contributes nothing to recall');

  const falsePositive = scoreQuestion(control, [range('src/cache.ts', 1, 5)]);
  assert.equal(falsePositive.category, 'no_evidence_control');
  assert.equal(falsePositive.complete_set_found, false);
  assert.equal(falsePositive.excerpts_returned, 1);
});

test('annotated precision counts overlap with any annotated set, and nothing else', () => {
  const subject = question({
    expected_evidence: [evidence('src/cache.ts', 10, 20)],
    alternative_evidence_sets: [[evidence('src/handler.ts', 1, 5)]],
  });
  const score = scoreQuestion(subject, [
    range('src/cache.ts', 12, 13),
    range('src/handler.ts', 2, 3),
    range('src/unrelated.ts', 1, 40),
  ]);
  assert.equal(score.excerpts_returned, 3);
  assert.equal(score.excerpts_overlapping_annotation, 2, 'an unannotated excerpt is neither credited nor condemned');
});

test('a range that only touches the boundary of an annotation counts as found', () => {
  const subject = question({ expected_evidence: [evidence('src/cache.ts', 10, 20)] });
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 20, 30)]).evidence_found, 1);
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 20, 30)]).complete_set_found, false);
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 21, 30)]).evidence_found, 0);
  assert.equal(scoreQuestion(subject, [range('src/other.ts', 10, 20)]).evidence_found, 0);
});

test('complete annotated coverage accepts adjacent ranges but refuses gaps and tiny overlaps', () => {
  const subject = question();
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 10, 14), range('src/cache.ts', 15, 20)]).complete_set_found, true);
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 10, 14), range('src/cache.ts', 16, 20)]).complete_set_found, false);
  assert.equal(scoreQuestion(subject, [range('src/cache.ts', 12, 12)]).complete_set_found, false);
  assert.throws(() => scoreQuestion(question({ expected_evidence: [] }), []), CorpusValidationError);
});
