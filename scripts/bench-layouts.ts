/**
 * Compact Jev payload experiment (roadmap section 11). Two steps, only `judge` makes provider requests:
 *
 *   judge    re-judge every captured candidate under one request layout, on identical chunks
 *   analyze  replay the default selection with each layout's scores; compare quality, agreement and cost
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { ProviderError } from '../src/evaluation/contracts.ts';
import { LAYOUT_VERSION } from '../src/evaluation/jev.ts';
import type { RequestLayout } from '../src/evaluation/contracts.ts';
import { batchLimits, fitsSerializedBatch } from '../src/evaluation/policy.ts';
import { serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import { environment, positiveInteger, projectRoot, writeReport } from './bench/common.ts';
import { batchItem, loadCases } from './bench/criteria.ts';
import type { Case } from './bench/criteria.ts';
import { falsePremiseVersion } from './bench/false-premise.ts';
import { LAYOUT_ARMS, planChunks, scoreCase } from './bench/layouts.ts';
import type { LayoutFile, LayoutJudgments, LayoutRequest, LayoutRow } from './bench/layouts.ts';
import { liveProvider } from './bench/live-provider.ts';
import { mapLimit } from './bench/real-tasks.ts';
import { mean, quantile } from './bench/report.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, layout: { type: 'string' }, output: { type: 'string' }, pools: { type: 'string' },
  judgments: { type: 'string' }, mirrors: { type: 'string' }, 'max-requests': { type: 'string' },
  'max-input-tokens': { type: 'string' }, jobs: { type: 'string' }, help: { type: 'boolean' },
} });

const usage = [
  'npm run bench:layouts -- judge --config <trusted-config> --layout <one of LAYOUT_ARMS> [--output file.json]',
  'npm run bench:layouts -- analyze --judgments a.json,b.json[,...] [--output benchmark-results/layouts.json]',
].join('\n');

const mirrors = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
const poolPaths = values.pools?.split(',') ?? ['synthetic-pilot-1', 'swe-bench-sample-1-dev', 'swe-bench-sample-1-heldout', falsePremiseVersion]
  .map((name) => join(projectRoot, 'benchmarks/pools', `${name}.json`));

async function judge(): Promise<void> {
  if (values.config === undefined) throw new Error('judge needs --config');
  const layout = values.layout as RequestLayout | undefined;
  if (layout === undefined || !LAYOUT_ARMS.includes(layout)) throw new Error(`--layout must be one of ${LAYOUT_ARMS.join(', ')}`);
  const live = liveProvider(values.config, {
    requests: positiveInteger(values['max-requests'], 400), estimatedInputTokens: positiveInteger(values['max-input-tokens'], 5_000_000),
  });
  const config = live.template.config;
  const limits = batchLimits(config.provider.adapter ?? 'typesafe-direct');
  const cases = await loadCases(poolPaths, mirrors);
  const results: LayoutJudgments[] = await mapLimit(cases, positiveInteger(values.jobs, 4), async (entry) => {
    const items = entry.pool.candidates.map((candidate) => batchItem(entry.files, candidate));
    // Chunks are planned with layout A, the largest envelope, so every layout sends the same groups.
    const chunks = planChunks(entry.pool.query, items, (batch) => serializeConfiguredBatch(config, batch),
      (body) => fitsSerializedBatch(body, limits));
    const scores: Record<string, number> = {};
    const requests: LayoutRequest[] = [];
    for (const chunk of chunks) {
      // The production layout is sent without the field, exactly as production sends it.
      const batch = { query: entry.pool.query, items: chunk, ...(layout === LAYOUT_VERSION ? {} : { layout }) };
      const bytes = Buffer.byteLength(serializeConfiguredBatch(config, batch), 'utf8');
      for (let attempt = 0; ; attempt += 1) {
        const started = performance.now();
        try {
          const result = await live.provider.evaluateBatch(batch);
          for (const [id, score] of result.scores) scores[id] = score;
          requests.push({ ids: chunk.map((item) => item.id), inputTokens: result.usage.inputTokens, bytes, ms: performance.now() - started,
            error: result.invalid.length === 0 ? null : `invalid answers: ${result.invalid.map((answer) => answer.reason).join(',')}` });
          break;
        } catch (cause) {
          const retry = cause instanceof ProviderError && cause.retryable && !cause.ambiguous && attempt < 3;
          if (!retry) {
            requests.push({ ids: chunk.map((item) => item.id), inputTokens: null, bytes, ms: performance.now() - started,
              error: cause instanceof Error ? cause.message : String(cause) });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (cause as ProviderError).retryAfterMs ?? 2_000 * (attempt + 1))));
        }
      }
    }
    console.error(`${layout} ${entry.id}: ${String(items.length)} candidates, ${String(chunks.length)} requests`);
    return { id: entry.id, scores, requests };
  });
  const report: LayoutFile = {
    schemaVersion: 1, kind: 'layout-judgments', layout, createdAt: new Date().toISOString(), environment: environment(),
    pools: poolPaths.map((path) => path.replace(projectRoot, '')), settings: live.settings, caps: live.caps, usage: live.usage, cases: results,
  };
  const failed = results.flatMap((entry) => entry.requests.filter((request) => request.error !== null));
  console.log(`Judgments: ${writeReport(values.output ?? `benchmark-results/layouts-${layout}.json`, report)}\nusage ${JSON.stringify(live.usage)}; failed requests ${String(failed.length)}`);
  if (failed.length > 0) process.exitCode = 1;
}

const GROUPS = ['all', 'synthetic', 'real-dev', 'real-heldout', 'false-premise'] as const;

function quality(rows: readonly LayoutRow[]) {
  const positive = rows.filter((row) => row.kind === 'positive' && row.metrics !== null);
  const premise = rows.filter((row) => row.kind === 'false-premise' && row.metrics !== null);
  const pick = (set: readonly LayoutRow[], key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage') =>
    mean(set.flatMap((row) => row.metrics?.[key] == null ? [] : [row.metrics[key]!]));
  return {
    searches: rows.length, incomplete: rows.filter((row) => !row.complete).length,
    recallAt1: pick(positive, 'recallAt1'), recallAt5: pick(positive, 'recallAt5'), mrr: pick(positive, 'reciprocalRank'),
    coverage: pick(positive, 'evidenceCoverage'), counterCoverage: pick(premise, 'evidenceCoverage'),
    negativeAccuracy: mean(rows.flatMap((row) => row.negativeCorrect === null ? [] : [Number(row.negativeCorrect)])),
    unannotated: mean(rows.map((row) => row.unannotated)), excerpts: mean(rows.map((row) => row.excerpts)),
  };
}

/** Candidate-level agreement of two score sets on the same cases, and searches whose result changed. */
function agreement(rows: readonly LayoutRow[], reference: readonly LayoutRow[], threshold: (index: number) => number) {
  const deltas: number[] = [];
  let crossings = 0;
  let changed = 0;
  rows.forEach((row, index) => {
    const base = reference[index]!;
    const limit = threshold(index);
    row.scores.forEach((score, at) => {
      deltas.push(Math.abs(score - base.scores[at]!));
      if ((score >= limit) !== (base.scores[at]! >= limit)) crossings += 1;
    });
    if (row.excerpts !== base.excerpts || row.metrics?.evidenceCoverage !== base.metrics?.evidenceCoverage
      || row.negativeCorrect !== base.negativeCorrect || row.unannotated !== base.unannotated) changed += 1;
  });
  return { candidates: deltas.length, meanAbsDelta: mean(deltas), p95AbsDelta: quantile(deltas, 0.95), crossings, changedSearches: changed };
}

function cost(file: LayoutFile | null) {
  if (file === null) return null;
  const requests = file.cases.flatMap((entry) => entry.requests);
  const candidates = requests.reduce((sum, request) => sum + request.ids.length, 0);
  const tokens = requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0);
  const bytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  return {
    requests: requests.length, errors: requests.filter((request) => request.error !== null).length,
    unknownUsage: requests.filter((request) => request.inputTokens === null).length, candidates,
    reportedInputTokens: tokens, tokensPerCandidate: tokens / candidates, bytesPerCandidate: bytes / candidates,
    msP50: quantile(requests.map((request) => request.ms), 0.5), msP95: quantile(requests.map((request) => request.ms), 0.95),
  };
}

const fmt = (value: number | null | undefined, digits = 3): string => value == null ? '-' : value.toFixed(digits);

async function analyze(): Promise<void> {
  if (values.judgments === undefined) throw new Error('analyze needs --judgments');
  const files = values.judgments.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8')) as LayoutFile);
  for (const file of files) if (file.kind !== 'layout-judgments') throw new Error('not a layout judgments file');
  const reference = files.find((file) => file.layout === 'layout-a-1');
  if (reference === undefined) throw new Error('analyze needs a layout-a-1 rerun as reference');
  const cases: Case[] = await loadCases(poolPaths, mirrors);
  const arms = [{ name: 'captured layout-a-1', file: null as LayoutFile | null }, ...files.map((file, index) => ({
    name: `${file.layout}${files.filter((other) => other.layout === file.layout).length > 1 ? ` #${String(index + 1)}` : ''}`, file,
  }))];
  const rowsOf = (file: LayoutFile | null): LayoutRow[] => {
    const byId = new Map(file?.cases.map((entry) => [entry.id, entry.scores]) ?? []);
    return cases.map((entry) => scoreCase(entry, file === null ? null : byId.get(entry.id) ?? {}));
  };
  const referenceRows = rowsOf(reference);
  const results = arms.map(({ name, file }) => {
    const rows = rowsOf(file);
    const byGroup = Object.fromEntries(GROUPS.map((group) => {
      const keep = rows.map((row, index) => ({ row, index })).filter(({ row }) => group === 'all' || row.group === group);
      return [group, {
        ...quality(keep.map(({ row }) => row)),
        vsReference: agreement(keep.map(({ row }) => row), keep.map(({ index }) => referenceRows[index]!), (at) => cases[keep[at]!.index]!.pool.threshold),
      }];
    }));
    return { name, layout: file?.layout ?? 'layout-a-1', cost: cost(file), groups: byGroup };
  });
  const report = {
    schemaVersion: 1, kind: 'layout-comparison', createdAt: new Date().toISOString(), environment: environment(),
    pools: poolPaths.map((path) => path.replace(projectRoot, '')), judgments: values.judgments.split(','),
    semantics: {
      reference: 'the first layout-a-1 rerun; captured layout-a-1 scores are a second layout-A sample and set the noise floor',
      agreement: 'absolute score difference and threshold crossings per candidate, and searches whose replayed result changed, against the reference',
      cost: 'requests, reported input tokens and serialized bytes for every captured candidate, on identical chunks',
    },
    results,
  };
  const path = writeReport(values.output ?? 'benchmark-results/layouts.json', report);
  for (const group of GROUPS) {
    console.log(`\n${group}: arm | R@1 | R@5 | MRR | coverage | counter | negatives | unannotated | incomplete | mean|d| | crossings | changed`);
    for (const { name, groups } of results) {
      const s = groups[group]!;
      console.log([name, fmt(s.recallAt1), fmt(s.recallAt5), fmt(s.mrr), fmt(s.coverage), fmt(s.counterCoverage), fmt(s.negativeAccuracy),
        fmt(s.unannotated, 2), String(s.incomplete), fmt(s.vsReference.meanAbsDelta, 4), String(s.vsReference.crossings), String(s.vsReference.changedSearches)].join(' | '));
    }
  }
  console.log('\ncost: arm | requests | errors | tokens | tokens/candidate | bytes/candidate | ms p50 | ms p95');
  for (const { name, cost: c } of results) {
    if (c !== null) console.log([name, c.requests, c.errors, c.reportedInputTokens, fmt(c.tokensPerCandidate, 1), fmt(c.bytesPerCandidate, 0), fmt(c.msP50, 0), fmt(c.msP95, 0)].join(' | '));
  }
  console.log(`\nReport: ${path}`);
}

if (values.help || positionals.length !== 1) console.log(usage);
else if (positionals[0] === 'judge') await judge();
else if (positionals[0] === 'analyze') await analyze();
else console.log(usage);
