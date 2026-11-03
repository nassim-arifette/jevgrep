/**
 * Experiment E8 runner (roadmap section 14). Three steps, only the first two make provider requests:
 *
 *   capture  live single-criterion searches for the false-premise questions, saved as candidate pools
 *   judge    focused judgments on the bounded ambiguous candidates of every captured pool
 *   analyze  offline routing arms over saved judgments; tuning picks one arm, held-out is scored once
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createSearchEngine } from '../src/engine.ts';
import { ProviderError } from '../src/evaluation/contracts.ts';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import {
  AMBIGUITY, FOCUSED_CRITERIA, JUDGMENT_KINDS, ROUTING_ARMS, SINGLE, ambiguousCandidates, batchItem, falsePremiseFiles, loadCases, routeCase,
} from './bench/criteria.ts';
import type { ArmRow, Case, CaseJudgments, Judgment, JudgmentFile, JudgmentKind, RoutingArm } from './bench/criteria.ts';
import { falsePremiseQuestions, falsePremiseVersion } from './bench/false-premise.ts';
import { liveProvider } from './bench/live-provider.ts';
import { mapLimit } from './bench/real-tasks.ts';
import { mean } from './bench/report.ts';
import { writeCapture } from './bench/replay.ts';
import type { CapturedPool } from './bench/replay.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, output: { type: 'string' }, pools: { type: 'string' }, judgments: { type: 'string' },
  mirrors: { type: 'string' }, 'max-requests': { type: 'string' }, 'max-input-tokens': { type: 'string' },
  'response-tokens': { type: 'string' }, jobs: { type: 'string' }, help: { type: 'boolean' },
} });

const usage = [
  'npm run bench:criteria -- capture --config <trusted-config> [--output benchmarks/pools/false-premise-1.json]',
  'npm run bench:criteria -- judge --config <trusted-config> [--pools a.json,b.json] [--output benchmark-results/criteria-judgments.json]',
  'npm run bench:criteria -- analyze --judgments j1.json[,j2.json] [--pools a.json,b.json] [--output benchmark-results/criteria.json]',
].join('\n');

const mirrors = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
const defaultPools = ['synthetic-pilot-1', 'swe-bench-sample-1-dev', 'swe-bench-sample-1-heldout', falsePremiseVersion]
  .map((name) => join(projectRoot, 'benchmarks/pools', `${name}.json`));
const poolPaths = values.pools?.split(',') ?? defaultPools;

async function capture(): Promise<void> {
  if (values.config === undefined) throw new Error('capture needs --config');
  const live = liveProvider(values.config, {
    requests: positiveInteger(values['max-requests'], 200), estimatedInputTokens: positiveInteger(values['max-input-tokens'], 2_000_000),
  });
  const responseTokens = positiveInteger(values['response-tokens'], 4_000);
  if (responseTokens > live.template.config.search.max_response_tokens) throw new Error('response budget exceeds trusted configuration maximum');
  const filesFor = await falsePremiseFiles(mirrors);
  const host = environment();
  const pools: CapturedPool[] = [];
  const notRun: string[] = [];
  for (const question of falsePremiseQuestions) {
    if (live.exhausted()) { notRun.push(question.id); continue; }
    console.error(`False premise ${question.id}`);
    const space = workspace(filesFor(question.source), (base) => live.configure(base));
    try {
      await createSearchEngine({ configuration: space.loaded, provider: live.provider }).search(
        { query: question.query, scope: ['.'], max_context_tokens: responseTokens },
        { searchId: question.id, onCandidatePool: (pool) => { pools.push({ id: question.id, source: JSON.stringify(question.source), pool }); } },
      );
    } finally {
      space.cleanup();
    }
  }
  const settings = { provider: live.settings, search: live.template.config.search, responseTokens, caps: live.caps, scoreCache: 'disabled', usage: live.usage };
  const path = writeCapture(values.output ?? join(projectRoot, 'benchmarks/pools', `${falsePremiseVersion}.json`),
    { kind: 'false-premise', dataset: falsePremiseVersion, environment: host, settings, pools });
  console.log(`Candidate pools: ${path}\nusage ${JSON.stringify(live.usage)}`);
  if (notRun.length > 0) { console.error(`not run: ${notRun.join(', ')}`); process.exitCode = 1; }
}

async function judge(): Promise<void> {
  if (values.config === undefined) throw new Error('judge needs --config');
  const live = liveProvider(values.config, {
    requests: positiveInteger(values['max-requests'], 300), estimatedInputTokens: positiveInteger(values['max-input-tokens'], 2_000_000),
  });
  const cases = await loadCases(poolPaths, mirrors);
  const host = environment();
  const judgeOne = async (entry: Case, kind: JudgmentKind, candidates: ReturnType<typeof ambiguousCandidates>): Promise<Judgment> => {
    const batch = { query: entry.pool.query, items: candidates.map((candidate) => batchItem(entry.files, candidate)), criterion: FOCUSED_CRITERIA[kind] };
    for (let attempt = 0; ; attempt += 1) {
      const started = performance.now();
      try {
        const result = await live.provider.evaluateBatch(batch);
        const invalid = result.invalid.length === 0 ? null : `invalid answers: ${result.invalid.map((answer) => answer.reason).join(',')}`;
        return { scores: Object.fromEntries(result.scores), inputTokens: result.usage.inputTokens, ms: performance.now() - started, error: invalid };
      } catch (cause) {
        const retry = cause instanceof ProviderError && cause.retryable && !cause.ambiguous && attempt < 3;
        if (!retry) return { scores: {}, inputTokens: null, ms: performance.now() - started, error: cause instanceof Error ? cause.message : String(cause) };
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (cause as ProviderError).retryAfterMs ?? 2_000 * (attempt + 1))));
      }
    }
  };
  const results: CaseJudgments[] = await mapLimit(cases, positiveInteger(values.jobs, 4), async (entry) => {
    const candidates = ambiguousCandidates(entry.pool);
    const judgments: Partial<Record<JudgmentKind, Judgment>> = {};
    if (candidates.length > 0) {
      for (const kind of JUDGMENT_KINDS) judgments[kind] = await judgeOne(entry, kind, candidates);
      console.error(`Judged ${entry.id}: ${String(candidates.length)} ambiguous`);
    }
    return { id: entry.id, candidates: candidates.map((candidate) => candidate.id), judgments };
  });
  const report: JudgmentFile = {
    schemaVersion: 1, kind: 'criteria-judgments', createdAt: new Date().toISOString(), environment: host,
    criteria: FOCUSED_CRITERIA, ambiguity: AMBIGUITY, pools: poolPaths.map((path) => path.replace(projectRoot, '')),
    settings: live.settings, caps: live.caps, usage: live.usage, cases: results,
  };
  const failed = results.flatMap((entry) => Object.values(entry.judgments).filter((judgment) => judgment.error !== null));
  console.log(`Judgments: ${writeReport(values.output ?? 'benchmark-results/criteria-judgments.json', report)}\nusage ${JSON.stringify(live.usage)}; failed judgments ${String(failed.length)}`);
  if (failed.length > 0) process.exitCode = 1;
}

type Summary = ReturnType<typeof summarize>;

function summarize(rows: readonly ArmRow[], baseline: readonly ArmRow[]) {
  const positive = rows.filter((row) => row.kind === 'positive' && row.metrics !== null);
  const premise = rows.filter((row) => row.kind === 'false-premise' && row.metrics !== null);
  const negative = rows.filter((row) => row.negativeCorrect !== null);
  const pick = (set: readonly ArmRow[], key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage') =>
    mean(set.flatMap((row) => row.metrics?.[key] == null ? [] : [row.metrics[key]!]));
  const coverage = (row: ArmRow | undefined): number | null => row?.metrics?.evidenceCoverage ?? null;
  let worse = 0;
  let better = 0;
  rows.forEach((row, index) => {
    const base = baseline[index]!;
    const delta = row.negativeCorrect !== null && base.negativeCorrect !== null
      ? Number(row.negativeCorrect) - Number(base.negativeCorrect) : (coverage(row) ?? 0) - (coverage(base) ?? 0);
    if (delta < 0) worse += 1;
    if (delta > 0) better += 1;
  });
  return {
    searches: rows.length, incomplete: rows.filter((row) => !row.complete).length,
    recallAt1: pick(positive, 'recallAt1'), recallAt5: pick(positive, 'recallAt5'), mrr: pick(positive, 'reciprocalRank'),
    coverage: pick(positive, 'evidenceCoverage'), fullSets: mean(positive.map((row) => Number(row.metrics!.evidenceCoverage === 1))),
    counterCoverage: pick(premise, 'evidenceCoverage'), counterFullSets: mean(premise.map((row) => Number(row.metrics!.evidenceCoverage === 1))),
    negativeAccuracy: mean(negative.map((row) => Number(row.negativeCorrect))),
    unannotated: mean(rows.map((row) => row.unannotated)), excerpts: mean(rows.map((row) => row.excerpts)),
    responseTokens: mean(rows.map((row) => row.measuredTokens)), crossings: rows.reduce((sum, row) => sum + row.crossings, 0),
    addedRequests: mean(rows.map((row) => row.addedRequests)), addedInputTokens: mean(rows.map((row) => row.addedInputTokens)),
    addedMs: mean(rows.map((row) => row.addedMs)), worse, better,
  };
}

/** Mean of each numeric field over repetitions. */
function average(summaries: readonly Summary[]): Summary {
  const keys = Object.keys(summaries[0]!) as (keyof Summary)[];
  return Object.fromEntries(keys.map((key) => [key, mean(summaries.flatMap((summary) => summary[key] === null ? [] : [summary[key]]))])) as Summary;
}

function evaluate(cases: readonly Case[], files: readonly JudgmentFile[], arm: RoutingArm) {
  const perRep = files.map((file) => {
    const byId = new Map(file.cases.map((entry) => [entry.id, entry]));
    const rows = cases.map((entry) => routeCase(entry, byId.get(entry.id), arm));
    const baseline = cases.map((entry) => routeCase(entry, byId.get(entry.id), SINGLE));
    return { rows, summary: summarize(rows, baseline) };
  });
  return { name: arm.name, uses: arm.uses, summary: average(perRep.map((rep) => rep.summary)), perRep };
}

const fmt = (value: number | null | undefined, digits = 3): string => value == null ? '-' : value.toFixed(digits);

/**
 * Predeclared choice on tuning: highest mean of positive coverage and false-premise
 * counterevidence coverage, with negative accuracy no lower and unannotated excerpts
 * at most 10% higher than single; ties go to fewer unannotated excerpts, then fewer requests.
 */
function choose(results: readonly ReturnType<typeof evaluate>[]) {
  const single = results.find((entry) => entry.name === SINGLE.name)!.summary;
  const target = (summary: Summary): number => ((summary.coverage ?? 0) + (summary.counterCoverage ?? 0)) / 2;
  const eligible = results.filter(({ name, summary }) => name !== SINGLE.name
    && (summary.negativeAccuracy ?? 1) >= (single.negativeAccuracy ?? 1)
    && (summary.unannotated ?? 0) <= (single.unannotated ?? 0) * 1.1);
  return eligible.sort((a, b) => target(b.summary) - target(a.summary) || (a.summary.unannotated ?? 0) - (b.summary.unannotated ?? 0)
    || a.uses.length - b.uses.length)[0] ?? null;
}

async function analyze(): Promise<void> {
  if (values.judgments === undefined) throw new Error('analyze needs --judgments');
  const files = values.judgments.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8')) as JudgmentFile);
  for (const file of files) if (file.kind !== 'criteria-judgments') throw new Error('not a judgments file');
  const cases = await loadCases(poolPaths, mirrors);
  const tuning = cases.filter((entry) => entry.split === 'tuning');
  const heldout = cases.filter((entry) => entry.split === 'heldout');
  const tuningResults = ROUTING_ARMS.map((arm) => evaluate(tuning, files, arm));
  const chosen = choose(tuningResults);
  const finalArms = chosen === null ? [SINGLE] : [SINGLE, ROUTING_ARMS.find((arm) => arm.name === chosen.name)!];
  const heldoutResults = finalArms.map((arm) => evaluate(heldout, files, arm));
  const strip = (results: readonly ReturnType<typeof evaluate>[]) => results.map(({ perRep, ...rest }) => ({
    ...rest, perRep: perRep.map((rep) => rep.summary),
    changedSearches: perRep.map((rep, index) => ({ rep: index + 1, searches: rep.rows.flatMap((row) => row.crossings === 0 ? [] : [{
      id: row.id, kind: row.kind, crossings: row.crossings, coverage: row.metrics?.evidenceCoverage ?? null,
      negativeCorrect: row.negativeCorrect, unannotated: row.unannotated,
    }]) })),
  }));
  const report = {
    schemaVersion: 1, kind: 'criteria-comparison', createdAt: new Date().toISOString(), environment: environment(),
    criteria: FOCUSED_CRITERIA, ambiguity: AMBIGUITY, repetitions: files.length,
    semantics: {
      single: 'captured single relevance judgment; every arm re-scores only the bounded ambiguous candidates and replays the default selection at the captured budget',
      unannotated: 'returned excerpts overlapping no required or complementary unit; on real tasks labels are not exhaustive, so this is a false-positive proxy',
      counterCoverage: 'required counterevidence covered on false-premise questions',
      cost: 'added requests, reported input tokens and request latency per search for the judgments an arm uses',
      choice: 'one arm chosen on tuning by the predeclared rule; held-out scored once with it',
    },
    tuning: strip(tuningResults), chosen: chosen?.name ?? null, heldout: strip(heldoutResults),
  };
  const path = writeReport(values.output ?? 'benchmark-results/criteria.json', report);
  for (const [label, results] of [['tuning', tuningResults], ['heldout', heldoutResults]] as const) {
    console.log(`\n${label} (${String(files.length)} rep): arm | R@1 | R@5 | MRR | coverage | full | counter cov | negatives | unannotated | crossings | worse | better | +req | +tokens | +ms`);
    for (const { name, summary: s } of results) {
      console.log([name, fmt(s.recallAt1), fmt(s.recallAt5), fmt(s.mrr), fmt(s.coverage), fmt(s.fullSets), fmt(s.counterCoverage),
        fmt(s.negativeAccuracy), fmt(s.unannotated, 2), fmt(s.crossings, 1), fmt(s.worse, 1), fmt(s.better, 1),
        fmt(s.addedRequests, 2), fmt(s.addedInputTokens, 0), fmt(s.addedMs, 0)].join(' | '));
    }
  }
  console.log(`\nChosen on tuning: ${chosen?.name ?? 'none'}\nReport: ${path}`);
}

if (values.help || positionals.length !== 1) console.log(usage);
else if (positionals[0] === 'capture') await capture();
else if (positionals[0] === 'judge') await judge();
else if (positionals[0] === 'analyze') await analyze();
else console.log(usage);
