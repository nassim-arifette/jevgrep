import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { SelectionPolicy, SelectionTuning } from '../src/response/selection.ts';
import { DEFAULT_SELECTION_TUNING } from '../src/response/selection.ts';
import { environment, projectRoot, writeReport } from './bench/common.ts';
import { loadReplayCases, replayPool } from './bench/replay.ts';
import type { ReplayArm, ReplayCase as Case } from './bench/replay.ts';
import { mean } from './bench/report.ts';
import { localizationRangeMetrics } from './bench/retrieval.ts';

const { values } = parseArgs({ options: {
  tuning: { type: 'string' }, heldout: { type: 'string' }, budgets: { type: 'string' },
  mirrors: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
} });

const usage = 'npm run bench:replay -- --tuning <pools.json>[,<pools.json>] [--heldout <pools.json>] [--budgets 1200,1600,2400,4000] [--output benchmark-results/replay.json]';

type Row = ReturnType<typeof measure>;

function measure(entry: Case, arm: ReplayArm) {
  const { result, measuredTokens } = replayPool(entry.pool, entry.files, arm);
  const complete = result.status === 'complete' && result.report.scope_fully_scanned;
  const metrics = complete ? localizationRangeMetrics(entry.query, result.excerpts) : null;
  return {
    id: entry.id, capture: entry.capture, negative: entry.query.negative, complete, measuredTokens,
    excerpts: result.excerpts.length, excerptLines: result.excerpts.reduce((sum, excerpt) => sum + excerpt.end_line - excerpt.start_line + 1, 0),
    metrics,
  };
}

function summarize(rows: readonly Row[]) {
  const positive = rows.filter((row) => row.metrics !== null && !row.negative);
  const negative = rows.filter((row) => row.metrics !== null && row.negative);
  const pick = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage' | 'complementaryCoverage') =>
    mean(positive.flatMap((row) => row.metrics?.[key] == null ? [] : [row.metrics[key]!]));
  return {
    searches: rows.length, incomplete: rows.filter((row) => !row.complete).length, positives: positive.length, negatives: negative.length,
    recallAt1: pick('recallAt1'), recallAt5: pick('recallAt5'), mrr: pick('reciprocalRank'),
    evidenceCoverage: pick('evidenceCoverage'),
    fullEvidenceSets: mean(positive.map((row) => Number(row.metrics!.evidenceCoverage === 1))),
    complementaryCoverage: pick('complementaryCoverage'),
    negativeAccuracy: mean(negative.map((row) => Number(row.metrics!.negativeCorrect))),
    meanResponseTokens: mean(rows.map((row) => row.measuredTokens)),
    meanExcerpts: mean(rows.map((row) => row.excerpts)),
    meanExcerptLines: mean(rows.map((row) => row.excerptLines)),
  };
}

/** Searches where an arm covers less required evidence than the default at the same budget. */
function counterexamples(rows: readonly Row[], baseline: readonly Row[]) {
  return rows.flatMap((row, index) => {
    const base = baseline[index]!;
    const ours = row.metrics?.evidenceCoverage ?? null;
    const theirs = base.metrics?.evidenceCoverage ?? null;
    return ours !== null && theirs !== null && ours !== theirs ? [{ id: row.id, coverage: ours, relevanceCoverage: theirs }] : [];
  });
}

type Candidate = { readonly name: string; readonly policy: SelectionPolicy; readonly tuning?: Partial<SelectionTuning> };

const candidates: Candidate[] = [
  { name: 'relevance', policy: 'relevance' },
  ...[0.3, 0.5, 0.7, 0.85].map((mmrLambda) => ({ name: `mmr λ=${String(mmrLambda)}`, policy: 'mmr' as const, tuning: { mmrLambda } })),
  ...[0.5, 1].flatMap((redundancyWeight) => [0, 0.5, 1].map((costExponent) => ({
    name: `marginal r=${String(redundancyWeight)} c=${String(costExponent)}`, policy: 'marginal' as const, tuning: { redundancyWeight, costExponent },
  }))),
];

function sweep(cases: readonly Case[], budgets: readonly number[], arms: readonly Candidate[]) {
  return arms.map((arm) => {
    const byBudget = budgets.map((requestedTokens) => {
      const rows = cases.map((entry) => measure(entry, { policy: arm.policy, ...(arm.tuning ? { tuning: arm.tuning } : {}), requestedTokens }));
      return { requestedTokens, rows };
    });
    return { ...arm, byBudget };
  });
}

function table(results: ReturnType<typeof sweep>) {
  const baseline = results.find((arm) => arm.name === 'relevance')!;
  return results.map((arm) => ({
    name: arm.name, policy: arm.policy, tuning: { ...DEFAULT_SELECTION_TUNING, ...arm.tuning },
    budgets: arm.byBudget.map(({ requestedTokens, rows }, index) => ({
      requestedTokens, summary: summarize(rows), counterexamples: counterexamples(rows, baseline.byBudget[index]!.rows),
    })),
    meanCoverage: mean(arm.byBudget.map(({ rows }) => summarize(rows).evidenceCoverage ?? 0)),
  }));
}

function calibration(cases: readonly Case[]) {
  const arms: { name: string; arm: ReplayArm }[] = [
    ...[0.3, 0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => ({ name: `threshold ${String(threshold)}`, arm: { policy: 'relevance' as const, threshold } })),
    ...[1, 3, 5].map((topK) => ({ name: `top-k ${String(topK)}`, arm: { policy: 'relevance' as const, topK } })),
    ...[0.1, 0.2, 0.3].map((scoreGap) => ({ name: `score gap ${String(scoreGap)}`, arm: { policy: 'relevance' as const, scoreGap } })),
  ];
  return arms.map(({ name, arm }) => ({ name, arm, summary: summarize(cases.map((entry) => measure(entry, arm))) }));
}

const fmt = (value: number | null): string => value === null ? '-' : value.toFixed(3);

if (values.help || values.tuning === undefined) {
  console.log(usage);
} else {
  const budgets = (values.budgets ?? '1200,1600,2400,4000').split(',').map(Number);
  const mirrors = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
  const tuning = await loadReplayCases(values.tuning.split(','), mirrors);
  const heldout = values.heldout === undefined ? [] : await loadReplayCases(values.heldout.split(','), mirrors);
  const tuningTable = table(sweep(tuning, budgets, candidates));
  // Pick one configuration per policy on the tuning split only; held-out is evaluated once.
  const chosen = ['mmr', 'marginal'].map((policy) => tuningTable.filter((arm) => arm.policy === policy)
    .reduce((best, arm) => (arm.meanCoverage ?? 0) > (best.meanCoverage ?? 0) ? arm : best));
  const finalArms = [candidates[0]!, ...chosen.map((arm) => candidates.find((entry) => entry.name === arm.name)!)];
  const heldoutTable = heldout.length === 0 ? [] : table(sweep(heldout, budgets, finalArms));
  const report = {
    schemaVersion: 1, kind: 'selection-replay', createdAt: new Date().toISOString(), environment: environment(),
    semantics: {
      replay: 'every arm re-selects from the same captured candidates and saved scores; no provider requests',
      cost: 'responseTokens is the measured serialized response after merging, metadata and the mandatory report',
      tuning: 'MMR and marginal parameters are chosen on the tuning split by mean evidence coverage over budgets; held-out is evaluated once with the chosen ones',
      counterexamples: 'searches where an arm covers a different fraction of required evidence than relevance at the same budget',
    },
    budgets, tuningSearches: tuning.length, heldoutSearches: heldout.length,
    chosen: chosen.map((arm) => arm.name), tuning: tuningTable, heldout: heldoutTable, calibration: calibration(tuning),
  };
  const path = writeReport(values.output ?? 'benchmark-results/replay.json', report);
  for (const [label, rows] of [['tuning', tuningTable], ['heldout', heldoutTable]] as const) {
    if (rows.length === 0) continue;
    console.log(`\n${label}: arm | budget | R@1 | R@5 | MRR | coverage | full sets | negatives | tokens | excerpts | counterexamples`);
    for (const arm of rows) for (const { requestedTokens, summary, counterexamples: lost } of arm.budgets) {
      console.log([arm.name, requestedTokens, fmt(summary.recallAt1), fmt(summary.recallAt5), fmt(summary.mrr), fmt(summary.evidenceCoverage),
        fmt(summary.fullEvidenceSets), fmt(summary.negativeAccuracy), fmt(summary.meanResponseTokens), fmt(summary.meanExcerpts), lost.length].join(' | '));
    }
  }
  console.log('\ncalibration (tuning, relevance): arm | R@5 | coverage | negatives | tokens | excerpts');
  for (const { name, summary } of report.calibration) {
    console.log([name, fmt(summary.recallAt5), fmt(summary.evidenceCoverage), fmt(summary.negativeAccuracy), fmt(summary.meanResponseTokens), fmt(summary.meanExcerpts)].join(' | '));
  }
  console.log(`\nChosen on tuning: ${report.chosen.join(', ')}\nReport: ${path}`);
}
