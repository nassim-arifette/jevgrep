import type { Excerpt, SearchOutcome } from '../../src/contracts.ts';
import type { Evidence } from './dataset.ts';

/** Any annotated question: an empty evidence list is a negative. */
export type EvidenceQuestion = { readonly evidence: readonly Evidence[] };

/** Full required lines must be covered; a duplicate/overlap cannot count twice. */
export function covered(evidence: Evidence, excerpts: readonly Excerpt[]): boolean {
  const ranges = excerpts.filter((excerpt) => excerpt.path === evidence.path)
    .sort((a, b) => a.start_line - b.start_line);
  let next = evidence.startLine;
  for (const range of ranges) {
    if (range.start_line > next) break;
    next = Math.max(next, range.end_line + 1);
    if (next > evidence.endLine) return true;
  }
  return false;
}

export function retrievalMetrics(question: EvidenceQuestion, outcome: SearchOutcome) {
  // Errors and partial scans are never successful negative answers.
  if (!('report' in outcome) || outcome.status !== 'complete' || !outcome.report.scope_fully_scanned) return null;
  const recall = (excerpts: readonly Excerpt[]): number =>
    question.evidence.filter((unit) => covered(unit, excerpts)).length / question.evidence.length;
  if (question.evidence.length === 0) {
    return { recallAt1: null, recallAt5: null, reciprocalRank: null, evidenceCoverage: null, negativeCorrect: outcome.excerpts.length === 0 };
  }
  const first = outcome.excerpts.findIndex((excerpt) => question.evidence.some((unit) => covered(unit, [excerpt])));
  return {
    recallAt1: recall(outcome.excerpts.slice(0, 1)), recallAt5: recall(outcome.excerpts.slice(0, 5)),
    reciprocalRank: first === -1 ? 0 : 1 / (first + 1),
    evidenceCoverage: recall(outcome.excerpts), negativeCorrect: null,
  };
}

export function summarizeRetrieval(results: readonly ReturnType<typeof retrievalMetrics>[]) {
  const complete = results.filter((row) => row !== null);
  const mean = (values: number[]): number | null => values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  return {
    total: results.length, complete: complete.length, incomplete: results.length - complete.length,
    positiveQuestions: complete.filter((row) => row.recallAt1 !== null).length,
    negativeQuestions: complete.filter((row) => row.negativeCorrect !== null).length,
    meanRecallAt1: mean(complete.flatMap((row) => row.recallAt1 === null ? [] : [row.recallAt1])),
    meanRecallAt5: mean(complete.flatMap((row) => row.recallAt5 === null ? [] : [row.recallAt5])),
    mrr: mean(complete.flatMap((row) => row.reciprocalRank === null ? [] : [row.reciprocalRank])),
    meanEvidenceCoverage: mean(complete.flatMap((row) => row.evidenceCoverage === null ? [] : [row.evidenceCoverage])),
    negativeAccuracy: mean(complete.flatMap((row) => row.negativeCorrect === null ? [] : [Number(row.negativeCorrect)])),
  };
}

export type LocalizationQuestion = EvidenceQuestion & { readonly complementary: readonly Evidence[] };

const overlaps = (unit: Evidence, excerpt: Excerpt): boolean =>
  excerpt.path === unit.path && excerpt.start_line <= unit.endLine && excerpt.end_line >= unit.startLine;

/**
 * Real-task labels are patch sites, not exhaustive relevance: file recall and first
 * overlapping hit are reported beside strict unit recall, and complementary context
 * is measured separately instead of being required.
 */
export function localizationMetrics(question: LocalizationQuestion, outcome: SearchOutcome) {
  const base = retrievalMetrics(question, outcome);
  if (base === null || !('report' in outcome) || question.evidence.length === 0) return base === null ? null : { ...base, fileRecall: null, firstOverlapRank: null, complementaryCoverage: null };
  const files = [...new Set(question.evidence.map((unit) => unit.path))];
  const first = outcome.excerpts.findIndex((excerpt) => question.evidence.some((unit) => overlaps(unit, excerpt)));
  return {
    ...base,
    fileRecall: files.filter((path) => outcome.excerpts.some((excerpt) => excerpt.path === path)).length / files.length,
    firstOverlapRank: first === -1 ? null : first + 1,
    complementaryCoverage: question.complementary.length === 0 ? null
      : question.complementary.filter((unit) => outcome.excerpts.some((excerpt) => overlaps(unit, excerpt))).length / question.complementary.length,
  };
}
