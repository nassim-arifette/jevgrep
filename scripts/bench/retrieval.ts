import type { Excerpt, SearchOutcome } from '../../src/contracts.ts';
import type { Evidence, RetrievalQuestion } from './dataset.ts';

/** Full required lines must be covered; a duplicate/overlap cannot count twice. */
function covered(evidence: Evidence, excerpts: readonly Excerpt[]): boolean {
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

export function retrievalMetrics(question: RetrievalQuestion, outcome: SearchOutcome) {
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
