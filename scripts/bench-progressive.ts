/**
 * Experiment for roadmap section 10: candidate priority in budgeted partial scans.
 *
 * Every arm runs the ordinary engine with `allow_partial_scan` on the pinned real-task
 * snapshots, answered offline from the captured exhaustive Jev scores (Jev judges each
 * fragment independently of its batch neighbors, see score-pool.ts). Only the order in
 * which the allowed partial scan admits candidates changes, at the same enabled cap.
 * No provider request is made.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Configuration, ScanCap, SearchResult } from '../src/contracts.ts';
import { createSearchEngine } from '../src/engine.ts';
import type { EvaluationBatch, ProviderClient } from '../src/evaluation/contracts.ts';
import { serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import { PATH_ORDER, PRIORITY_VERSION, type CandidateOrder } from '../src/priority.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import type { Evidence } from './bench/dataset.ts';
import { environment, projectRoot, workspace, writeReport } from './bench/common.ts';
import { loadManifest, type RealQuery, type RealTask } from './bench/real-tasks.ts';
import { mean } from './bench/report.ts';
import { covered, localizationRangeMetrics, type Range } from './bench/retrieval.ts';
import { loadPool, replayProvider, sha256, type PoolQuery } from './bench/score-pool.ts';
import { loadSnapshots } from './bench/snapshots.ts';

const { values } = parseArgs({ options: {
  replay: { type: 'string' }, mirrors: { type: 'string' }, output: { type: 'string' }, budgets: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm run bench:progressive -- [--replay benchmarks/pools/e7-swe-bench-sample-1-scores.json] [--budgets 0.1,0.25,0.5] [--output benchmark-results/progressive.json]');
  process.exit(0);
}

const pool = loadPool(values.replay ?? join(projectRoot, 'benchmarks/pools/e7-swe-bench-sample-1-scores.json'));
const budgets = (values.budgets ?? '0.1,0.25,0.5').split(',').map(Number);
const responseTokens = 4_000;
const ORDERS: Readonly<Record<string, CandidateOrder>> = {
  path: PATH_ORDER,
  priority: { kind: 'priority', reserve: 0 },
  'priority+reserve25': { kind: 'priority', reserve: 0.25 },
  'priority+reserve50': { kind: 'priority', reserve: 0.5 },
};

const overlaps = (unit: Evidence, range: Range): boolean => unit.path === range.path && range.start_line <= unit.endLine && range.end_line >= unit.startLine;

type RunOptions = { readonly order: CandidateOrder; readonly caps: Partial<Record<ScanCap, number>>; readonly rounds?: number };
type Round = {
  status: SearchResult['status']; stop: readonly string[]; remote: number; reused: number; total: number | null; requests: number; tokens: number;
  candidateRecall: number | null; firstUsefulBatch: number | null; metrics: ReturnType<typeof localizationRangeMetrics> | null;
  newExcerpts: number;
};

async function run(task: RealTask, query: RealQuery, files: Readonly<Record<string, string>>, entry: PoolQuery, options: RunOptions): Promise<Round[]> {
  const configure = (base: Configuration): Configuration => ({
    ...base, remote_evaluation_enabled: true, provider: pool.provider, search: pool.search,
    scan_caps: { ...base.scan_caps, ...options.caps },
    // Continuation reuses the score cache; a single round never reads it.
    cache: { ...base.cache, enabled: (options.rounds ?? 1) > 1 },
  });
  const space = workspace(files, configure);
  const config = space.loaded.config;
  const rounds: Round[] = [];
  const seen = new Set<string>();
  try {
    for (let round = 0; round < (options.rounds ?? 1); round += 1) {
      const { provider: replay } = replayProvider(pool, entry, config, null);
      let requests = 0; let tokens = 0; let firstUsefulBatch: number | null = null;
      const provider: ProviderClient = {
        ...replay,
        async evaluateBatch(batch: EvaluationBatch, signal?: AbortSignal) {
          requests += 1;
          const index = requests;
          tokens += countReferenceTokens(serializeConfiguredBatch(config, batch));
          const result = await replay.evaluateBatch(batch, signal);
          const useful = batch.items.some((item) => (result.scores.get(item.id) ?? 0) >= config.search.threshold
            && query.evidence.some((unit) => overlaps(unit, { path: item.path, start_line: item.startLine, end_line: item.endLine })));
          if (useful && firstUsefulBatch === null) firstUsefulBatch = index;
          return result;
        },
      };
      let evaluated: Range[] = [];
      const engine = createSearchEngine({ configuration: space.loaded, provider, candidateOrder: options.order });
      const outcome = (await engine.search(
        { query: query.query, scope: ['.'], max_context_tokens: responseTokens, allow_partial_scan: true },
        { searchId: `${query.id}-${String(round)}`, onCandidatePool: (captured) => {
          evaluated = captured.candidates.map((candidate) => ({ path: candidate.path, start_line: candidate.startLine, end_line: candidate.endLine }));
        } },
      )).outcome;
      if (!('report' in outcome)) throw new Error(`${query.id}: ${outcome.error.code}`);
      const excerpts = outcome.excerpts.map((excerpt) => `${excerpt.path}:${String(excerpt.start_line)}-${String(excerpt.end_line)}`);
      rounds.push({
        status: outcome.status, stop: outcome.report.stop_reasons, remote: outcome.report.fragments.remote_evaluated,
        reused: outcome.report.fragments.cache_reused, total: outcome.report.fragments.total, requests, tokens,
        candidateRecall: query.evidence.length === 0 ? null : query.evidence.filter((unit) => covered(unit, evaluated)).length / query.evidence.length,
        firstUsefulBatch, metrics: localizationRangeMetrics(query, outcome.excerpts),
        newExcerpts: excerpts.filter((key) => !seen.has(key)).length,
      });
      for (const key of excerpts) seen.add(key);
    }
  } finally {
    space.cleanup();
  }
  void task;
  return rounds;
}

const manifest = loadManifest();
const snapshots = await loadSnapshots(manifest.tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
const queries = manifest.tasks.flatMap((task) => task.queries.map((query) => ({ task, query })));
for (const { query } of queries) {
  if (pool.queries[query.id]?.questionSha256 !== sha256(query.query)) throw new Error(`${query.id} missing from the score pool`);
}

type Row = { id: string; split: string; experiment: string; arm: string; budget: number; rounds: Round[] };
const rows: Row[] = [];
for (const { task, query } of queries) {
  const files = snapshots.get(task.id)!;
  const entry = pool.queries[query.id]!;
  const [full] = await run(task, query, files, entry, { order: PATH_ORDER, caps: {} });
  const fullRequests = full!.requests;
  const fullTokens = full!.tokens;
  const fileCount = Object.keys(files).length;
  rows.push({ id: query.id, split: task.split, experiment: 'exhaustive', arm: 'path', budget: 1, rounds: [full!] });
  for (const budget of budgets) {
    for (const [arm, order] of Object.entries(ORDERS)) {
      const tokenCap = { estimated_input_tokens: Math.max(1, Math.floor(budget * fullTokens)) };
      rows.push({ id: query.id, split: task.split, experiment: 'token-cap', arm, budget, rounds: await run(task, query, files, entry, { order, caps: tokenCap }) });
      rows.push({ id: query.id, split: task.split, experiment: 'file-cap', arm, budget,
        rounds: await run(task, query, files, entry, { order, caps: { candidate_files: Math.max(1, Math.floor(budget * fileCount)) } }) });
      if (budget === 0.25) {
        rows.push({ id: query.id, split: task.split, experiment: 'continuation', arm, budget,
          rounds: await run(task, query, files, entry, { order, caps: tokenCap, rounds: 4 }) });
      }
    }
  }
  console.error(`${query.id}: ${String(fullRequests)} requests exhaustive`);
}

const fmt = (value: number | null | undefined): string => value == null ? '-' : value.toFixed(3);
function summarize(group: readonly Row[], round = 0) {
  const at = group.map((row) => row.rounds[Math.min(round, row.rounds.length - 1)]!);
  const pick = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'fileRecall') => mean(at.flatMap((r) => r.metrics?.[key] == null ? [] : [r.metrics[key]!]));
  const firstUseful = at.map((r) => r.firstUsefulBatch);
  return {
    searches: group.length, recallAt1: pick('recallAt1'), recallAt5: pick('recallAt5'), mrr: pick('reciprocalRank'), fileRecall: pick('fileRecall'),
    candidateRecall: mean(at.flatMap((r) => r.candidateRecall === null ? [] : [r.candidateRecall])),
    usefulFound: firstUseful.filter((value) => value !== null).length,
    firstUsefulBatch: mean(firstUseful.flatMap((value) => value === null ? [] : [value])),
    requests: mean(at.map((r) => r.requests)), tokens: mean(at.map((r) => r.tokens)),
    evaluatedShare: mean(at.flatMap((r) => r.total === null || r.total === 0 ? [] : [(r.remote + r.reused) / r.total])),
    complete: at.filter((r) => r.status === 'complete').length,
    completeWithUnevaluated: at.filter((r) => r.status === 'complete' && r.remote + r.reused < (r.total ?? Infinity)).length,
    newExcerpts: mean(at.map((r) => r.newExcerpts)),
  };
}

const summary: Record<string, unknown> = {};
// "complete (n)": n counts complete results that left fragments unevaluated; it must be 0.
console.log(['arm', 'R@1', 'R@5', 'MRR', 'candidate recall', 'useful found', 'first useful batch', 'requests', 'tokens',
  'evaluated share', 'complete (with unevaluated)', 'new excerpts'].join(' | '));
for (const split of ['dev', 'heldout']) {
  for (const experiment of ['exhaustive', 'token-cap', 'file-cap', 'continuation']) {
    const arms = [...new Set(rows.filter((row) => row.experiment === experiment).map((row) => `${row.arm}@${String(row.budget)}`))];
    for (const key of arms) {
      const [arm, budget] = key.split('@');
      const group = rows.filter((row) => row.split === split && row.experiment === experiment && row.arm === arm && String(row.budget) === budget);
      if (group.length === 0) continue;
      const rounds = experiment === 'continuation' ? group[0]!.rounds.length : 1;
      for (let round = 0; round < rounds; round += 1) {
        const s = summarize(group, round);
        const label = `${split} ${experiment} ${arm} budget=${budget!}${rounds > 1 ? ` round=${String(round + 1)}` : ''}`;
        summary[label] = s;
        console.log([label, fmt(s.recallAt1), fmt(s.recallAt5), fmt(s.mrr), fmt(s.candidateRecall), `${String(s.usefulFound)}/${String(s.searches)}`,
          fmt(s.firstUsefulBatch), fmt(s.requests), Math.round(s.tokens ?? 0), fmt(s.evaluatedShare), `${String(s.complete)} (${String(s.completeWithUnevaluated)})`, fmt(s.newExcerpts)].join(' | '));
      }
    }
  }
}

const path = writeReport(values.output ?? 'benchmark-results/progressive.json', {
  schemaVersion: 1, kind: 'progressive-search', createdAt: new Date().toISOString(), environment: environment(), priority: PRIORITY_VERSION,
  orders: ORDERS, budgets, responseTokens, pool: values.replay ?? 'benchmarks/pools/e7-swe-bench-sample-1-scores.json',
  replay: 'captured exhaustive Jev scores; the engine plans, orders, batches and selects as in a live partial scan; no provider request',
  summary, rows,
});
console.log(`Report: ${path}`);
