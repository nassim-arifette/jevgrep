/**
 * Supplied candidates and focused reading (roadmap section 9, Stage A: E4 and the
 * E5 baseline). Every arm runs the real engine on the existing file-level `scope`,
 * answered with the scores captured by the full authorized scan, so arms differ only
 * in which files were supplied. No provider request is made; Jev work is the
 * engine's own preflight estimate for the supplied files.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfiguration } from '../src/config.ts';
import { createSearchEngine } from '../src/engine.ts';
import { serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import type { CandidatePool } from '../src/response/candidate-pool.ts';
import { PoolProvider, lexicalFiles, mentionedFiles, preparedPaths } from './bench/candidates.ts';
import { environment, projectRoot, workspace, writeReport } from './bench/common.ts';
import { liveProvider } from './bench/live-provider.ts';
import { loadReplayCases, replayPool } from './bench/replay.ts';
import type { ReplayCase } from './bench/replay.ts';
import { mean } from './bench/report.ts';
import { localizationRangeMetrics } from './bench/retrieval.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, pools: { type: 'string' }, sizes: { type: 'string' }, mirrors: { type: 'string' },
  output: { type: 'string' }, live: { type: 'string' }, 'max-requests': { type: 'string' }, 'max-input-tokens': { type: 'string' },
  help: { type: 'boolean' },
} });

const usage = 'npm run bench:candidates -- --config <trusted-config> --pools <pools.json>[,<pools.json>] [--sizes 1,3,5,10] [--output benchmark-results/candidates.json] [--live "<arm>" --max-requests N --max-input-tokens N]';

type Arm = { readonly name: string; readonly family: 'full' | 'lexical' | 'mentioned' | 'supplied'; readonly files: readonly string[] | null };

function arms(entry: ReplayCase, sizes: readonly number[]): Arm[] {
  const paths = preparedPaths(entry.pool);
  const evidenceFiles = [...new Set(entry.query.evidence.map((unit) => unit.path))];
  return [
    { name: 'full scan', family: 'full', files: null },
    ...sizes.map((size) => ({ name: `lexical top-${String(size)}`, family: 'lexical' as const, files: lexicalFiles(entry.pool.query, entry.files, paths, size) })),
    { name: 'mentioned paths', family: 'mentioned', files: mentionedFiles(entry.pool.query, paths) },
    // E5: the question arrives with the files that hold its evidence, as an agent that already located them.
    ...(evidenceFiles.length === 0 ? [] : [{ name: 'supplied evidence files', family: 'supplied' as const, files: evidenceFiles }]),
  ];
}

const fileTokens = (entry: ReplayCase, files: readonly string[]): number => files.reduce((sum, path) => sum + countReferenceTokens(entry.files[path] ?? ''), 0);

type Live = ReturnType<typeof liveProvider>;

async function run(entry: ReplayCase, arm: Arm, template: ReturnType<typeof loadConfiguration>, live?: Live) {
  const files = arm.files ?? preparedPaths(entry.pool);
  const units = entry.query.evidence;
  const candidateRecall = units.length === 0 ? null : units.filter((unit) => files.includes(unit.path)).length / units.length;
  const base = { id: entry.id, capture: entry.capture, negative: entry.query.negative, arm: arm.name, family: arm.family, candidates: files.length, candidateRecall };
  // An empty list means the supplier had nothing to offer: no search, no evidence, no Jev work.
  if (files.length === 0) {
    return { ...base, searched: false, complete: true, metrics: localizationRangeMetrics(entry.query, []), missedByCandidates: units.length, missedBySelection: 0,
      jevInputTokens: 0, jevCostUsd: 0, responseTokens: 0, listTokens: 0, fullReadTokens: 0, rereadFiles: 0, rereadTokens: 0, excerpts: [], scored: null };
  }
  const provider = live?.provider ?? new PoolProvider(entry.pool, template.config.provider.model, (batch) => serializeConfiguredBatch(template.config, batch));
  let scored: CandidatePool | null = null;
  const space = workspace(entry.files, (config) => live !== undefined ? live.configure(config) : ({
    ...config, remote_evaluation_enabled: true, provider: template.config.provider, search: template.config.search,
    scan_caps: { ...config.scan_caps, estimated_input_tokens: null, request_attempts: null, estimated_cost_usd: null }, cache: { ...config.cache, enabled: false },
  }));
  try {
    const { outcome, measuredTokens } = await createSearchEngine({ configuration: space.loaded, provider }).search({
      query: entry.pool.query, scope: arm.files ?? ['.'], max_context_tokens: entry.pool.requestedTokens,
    }, { searchId: entry.pool.searchId, onCandidatePool: (pool) => { scored = pool; } });
    if (!('report' in outcome)) throw new Error(`${entry.id} ${arm.name}: ${outcome.error.code}`);
    const complete = outcome.status === 'complete' && outcome.report.scope_fully_scanned;
    const covered = (unit: typeof units[number]) => localizationRangeMetrics({ evidence: [unit], complementary: [] }, outcome.excerpts).evidenceCoverage === 1;
    const missed = units.filter((unit) => !covered(unit));
    // E5 reading model: an agent rereads in full every supplied file whose evidence the excerpts missed.
    const rereads = [...new Set(missed.filter((unit) => files.includes(unit.path)).map((unit) => unit.path))];
    return {
      ...base, searched: true, complete, metrics: complete ? localizationRangeMetrics(entry.query, outcome.excerpts) : null,
      missedByCandidates: missed.filter((unit) => !files.includes(unit.path)).length, missedBySelection: missed.filter((unit) => files.includes(unit.path)).length,
      jevInputTokens: outcome.report.usage.provider_input_tokens_estimated, jevCostUsd: outcome.report.usage.estimated_cost_usd ?? 0,
      responseTokens: measuredTokens ?? 0, listTokens: arm.files === null ? 0 : countReferenceTokens(files.join('\n')),
      fullReadTokens: fileTokens(entry, files), rereadFiles: rereads.length, rereadTokens: fileTokens(entry, rereads),
      excerpts: outcome.excerpts.map((excerpt) => ({ path: excerpt.path, start_line: excerpt.start_line, end_line: excerpt.end_line })),
      scored: scored as CandidatePool | null,
    };
  } finally {
    space.cleanup();
  }
}

type Row = Awaited<ReturnType<typeof run>>;

function summarize(rows: readonly Row[]) {
  const positive = rows.filter((row) => !row.negative && row.metrics !== null);
  const negative = rows.filter((row) => row.negative && row.metrics !== null);
  const pick = (read: (row: Row) => number | null | undefined) => mean(positive.flatMap((row) => { const value = read(row); return value == null ? [] : [value]; }));
  const total = (read: (row: Row) => number) => rows.reduce((sum, row) => sum + read(row), 0);
  return {
    searches: rows.length, positives: positive.length, negatives: negative.length, incomplete: rows.filter((row) => !row.complete).length,
    noCandidates: rows.filter((row) => !row.searched).length,
    meanCandidates: mean(rows.map((row) => row.candidates)),
    candidateRecall: pick((row) => row.candidateRecall), recallAt5: pick((row) => row.metrics?.recallAt5),
    evidenceCoverage: pick((row) => row.metrics?.evidenceCoverage),
    fullEvidenceSets: mean(positive.map((row) => Number(row.metrics!.evidenceCoverage === 1))),
    fileRecall: pick((row) => row.metrics?.fileRecall),
    negativeAccuracy: mean(negative.map((row) => Number(row.metrics!.negativeCorrect))),
    missedByCandidates: total((row) => row.missedByCandidates), missedBySelection: total((row) => row.missedBySelection),
    meanJevInputTokens: mean(rows.map((row) => row.jevInputTokens)), totalJevCostUsd: total((row) => row.jevCostUsd),
    meanResponseTokens: mean(rows.map((row) => row.responseTokens)),
    meanAgentTokens: mean(rows.map((row) => row.listTokens + row.responseTokens + row.rereadTokens)),
    meanFullReadTokens: mean(rows.map((row) => row.fullReadTokens)),
    meanRereadFiles: mean(rows.map((row) => row.rereadFiles)),
  };
}

if (values.help || values.pools === undefined || values.config === undefined) {
  console.log(usage);
} else {
  const template = loadConfiguration(values.config);
  const sizes = (values.sizes ?? '1,3,5,10').split(',').map(Number);
  const cases = await loadReplayCases(values.pools.split(','), values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
  const rows: Row[] = [];
  let fidelity = 0;
  for (const entry of cases) {
    for (const arm of arms(entry, sizes)) {
      const row = await run(entry, arm, template);
      if (arm.family === 'full') {
        // The full arm must reproduce the captured selection exactly, or arms are not comparable.
        const replayed = replayPool(entry.pool, entry.files, { policy: 'relevance' }).result;
        const expected = 'excerpts' in replayed ? replayed.excerpts.map((excerpt) => ({ path: excerpt.path, start_line: excerpt.start_line, end_line: excerpt.end_line })) : [];
        if (JSON.stringify(expected) !== JSON.stringify(row.excerpts)) throw new Error(`${entry.id}: full-scan arm does not reproduce the captured selection`);
        fidelity += 1;
      }
      rows.push(row);
    }
    console.error(`Candidates ${entry.id}`);
  }
  // Live check: the replay assumes a scoped search receives the judgments the full scan
  // received. Rerun one arm against Jev and compare fresh scores with the captured ones.
  let liveCheck = null;
  if (values.live !== undefined) {
    const live = liveProvider(values.config, {
      requests: Number(values['max-requests'] ?? 40), estimatedInputTokens: Number(values['max-input-tokens'] ?? 400_000),
    });
    const checks = [];
    for (const entry of cases) {
      const arm = arms(entry, sizes).find((candidate) => candidate.name === values.live);
      if (arm === undefined || arm.files === null || arm.files.length === 0 || live.exhausted()) continue;
      const replayed = rows.find((row) => row.id === entry.id && row.capture === entry.capture && row.arm === arm.name)!;
      const fresh = await run(entry, arm, template, live);
      const captured = new Map(entry.pool.candidates.map((candidate) => [`${candidate.path}:${String(candidate.startLine)}-${String(candidate.endLine)}`, candidate.score]));
      const deltas = (fresh.scored?.candidates ?? []).flatMap((candidate) => {
        const before = captured.get(`${candidate.path}:${String(candidate.startLine)}-${String(candidate.endLine)}`);
        return before === undefined ? [] : [Math.abs(candidate.score - before)];
      });
      checks.push({
        id: entry.id, arm: arm.name, fragments: deltas.length, meanAbsScoreDelta: mean(deltas), maxAbsScoreDelta: deltas.length === 0 ? null : Math.max(...deltas),
        sameExcerpts: JSON.stringify(fresh.excerpts) === JSON.stringify(replayed.excerpts),
        replayedCoverage: replayed.metrics?.evidenceCoverage ?? null, liveCoverage: fresh.metrics?.evidenceCoverage ?? null,
      });
      console.error(`Live ${entry.id}`);
    }
    liveCheck = {
      arm: values.live, caps: live.caps, attempts: live.usage.attempts, reservedInputTokens: live.usage.reservedInputTokens,
      reportedInputTokens: live.usage.reportedInputTokens, checks,
    };
  }
  const splits = [...new Set(rows.map((row) => row.capture))];
  const names = [...new Set(rows.map((row) => row.arm))];
  const summary = Object.fromEntries(splits.map((split) => [split, Object.fromEntries(names.flatMap((name) => {
    const group = rows.filter((row) => row.capture === split && row.arm === name);
    return group.length === 0 ? [] : [[name, summarize(group)]];
  }))]));
  const report = {
    schemaVersion: 1, kind: 'supplied-candidates', createdAt: new Date().toISOString(), environment: environment(),
    semantics: {
      scores: 'every arm reuses the scores captured by the full authorized scan through the real engine; no provider requests',
      jev: 'meanJevInputTokens and totalJevCostUsd are the engine preflight estimates for the supplied files at the configured price',
      candidates: 'lexical: BM25 over prepared files; mentioned: paths named in the question resolved by suffix; supplied: the files holding the labelled evidence (E5)',
      agent: 'agent tokens = candidate list + JevGrep response + full rereads of supplied files whose evidence was missed; fullRead = reading every supplied file in full',
      coverage: 'a scoped search reports coverage of the supplied files only; missedByCandidates counts evidence in files never supplied',
    },
    sizes, fidelity, searches: cases.length, summary, liveCheck, rows: rows.map(({ scored: _scored, ...row }) => row),
  };
  const path = writeReport(values.output ?? 'benchmark-results/candidates.json', report);
  const fmt = (value: number | null): string => value === null ? '-' : Number.isInteger(value) ? String(value) : value.toFixed(3);
  for (const split of splits) {
    console.log(`\n${split}: arm | files | cand. recall | R@5 | coverage | full sets | negatives | missed (cand/sel) | Jev tokens | response | agent | full read | rereads | none`);
    for (const [name, s] of Object.entries(summary[split]!)) {
      console.log([name, fmt(s.meanCandidates), fmt(s.candidateRecall), fmt(s.recallAt5), fmt(s.evidenceCoverage), fmt(s.fullEvidenceSets), fmt(s.negativeAccuracy),
        `${String(s.missedByCandidates)}/${String(s.missedBySelection)}`, fmt(s.meanJevInputTokens), fmt(s.meanResponseTokens), fmt(s.meanAgentTokens),
        fmt(s.meanFullReadTokens), fmt(s.meanRereadFiles), s.noCandidates].join(' | '));
    }
  }
  if (liveCheck !== null) {
    console.log(`\nLive check (${liveCheck.arm}): ${String(liveCheck.attempts)} requests, ${String(liveCheck.reservedInputTokens)} reserved input tokens`);
    for (const check of liveCheck.checks) {
      console.log([check.id, check.fragments, fmt(check.meanAbsScoreDelta), fmt(check.maxAbsScoreDelta), check.sameExcerpts, fmt(check.replayedCoverage), fmt(check.liveCoverage)].join(' | '));
    }
  }
  console.log(`\nFull-scan fidelity: ${String(fidelity)}/${String(cases.length)}\nReport: ${path}`);
}
