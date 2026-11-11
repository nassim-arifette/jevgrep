/**
 * Comparison of Jev with OpenAI judges on the captured E2/E8 candidate pools.
 *
 * Every candidate is judged on the same deterministic chunks as the Jev layout runs,
 * with the production model-visible excerpt (`layout-a-nolines-1`: path, structure
 * label and text, positional keys). Two OpenAI shapes:
 *
 *   decisions  POST /v1/decisions, one predicate question per excerpt (a probability)
 *   chat       POST /v1/responses with a strict JSON schema, one probability per excerpt
 *
 *   node scripts/bench-openai-judges.ts judge --chunk-config <trusted-config> --arm decisions --model gpt-6-luna --output a.json
 *   node scripts/bench-openai-judges.ts judge --chunk-config <trusted-config> --arm chat --model gpt-6-luna --effort none --output b.json
 *   node scripts/bench-openai-judges.ts compare --judgments jev.json,a.json,b.json --prices ...
 *
 * Only `judge` makes provider requests (needs OPENAI_API_KEY).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadConfiguration } from '../src/config.ts';
import type { BatchItem } from '../src/evaluation/contracts.ts';
import { RELEVANCE_CRITERION, questionInstructions } from '../src/evaluation/jev.ts';
import { batchLimits, fitsSerializedBatch } from '../src/evaluation/policy.ts';
import { serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import { environment, positiveInteger, projectRoot, writeReport } from './bench/common.ts';
import { batchItem, loadCases } from './bench/criteria.ts';
import { falsePremiseVersion } from './bench/false-premise.ts';
import { judgeCaseTiming, judgeWithRetries, summarizeJudgeUsage, type JudgePrice, type JudgeReply, type JudgeRequest } from './bench/judge-accounting.ts';
import { planChunks, scoreCase, type LayoutRow } from './bench/layouts.ts';
import { mapLimit } from './bench/real-tasks.ts';
import { mean, quantile } from './bench/report.ts';

const LAYOUT = 'layout-a-nolines-1' as const;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  arm: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'chunk-config': { type: 'string' },
  cases: { type: 'string' }, jobs: { type: 'string' }, output: { type: 'string' }, judgments: { type: 'string' },
  labels: { type: 'string' }, prices: { type: 'string' }, mirrors: { type: 'string' },
} });
const mirrors = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
const poolPaths = ['synthetic-pilot-1', 'swe-bench-sample-1-dev', 'swe-bench-sample-1-heldout', falsePremiseVersion]
  .map((name) => join(projectRoot, 'benchmarks/pools', `${name}.json`));

type Judged = { readonly id: string; readonly scores: Record<string, number>; readonly requests: JudgeRequest[]; readonly wallMs?: number };

const SYSTEM = `You judge excerpts of a code repository for a code search tool. ${RELEVANCE_CRITERION.replace(' Return the Noul affirmative probability.', '')}`
  + ' For every excerpt key, return the probability (0 to 1) that the excerpt meets this criterion.';

function body(arm: string, model: string, effort: string | undefined, query: string, chunk: readonly BatchItem[]): { path: string; json: unknown } {
  const keys = chunk.map((_, index) => `e${String(index + 1)}`);
  if (arm === 'decisions') {
    return { path: '/v1/decisions', json: {
      model,
      input: `Search question: ${query}\n\nCriterion: ${RELEVANCE_CRITERION.replace(' Return the Noul affirmative probability.', '')}`,
      questions: chunk.map((item, index) => ({
        type: 'predicate', name: keys[index],
        instructions: `This excerpt meets the criterion for the search question.\n\n${questionInstructions(item, LAYOUT)}`,
      })),
    } };
  }
  const excerpts = chunk.map((item, index) => `<excerpt key="${keys[index]!}">\n${questionInstructions(item, LAYOUT)}\n</excerpt>`).join('\n\n');
  return { path: '/v1/responses', json: {
    model, instructions: SYSTEM, store: false,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    input: `Search question: ${query}\n\n${excerpts}`,
    text: { format: { type: 'json_schema', name: 'excerpt_probabilities', strict: true, schema: {
      type: 'object', additionalProperties: false, required: keys,
      properties: Object.fromEntries(keys.map((key) => [key, { type: 'number' }])),
    } } },
  } };
}

function parse(arm: string, chunk: readonly BatchItem[], raw: Record<string, unknown>): Map<string, number> {
  const scores = new Map<string, number>();
  const byKey = new Map(chunk.map((item, index) => [`e${String(index + 1)}`, item.id]));
  if (arm === 'decisions') {
    for (const answer of (raw['answers'] as { name: string | null; type: string; probability?: number }[] | undefined) ?? []) {
      const id = byKey.get(answer.name ?? '');
      if (id !== undefined && answer.type === 'predicate' && typeof answer.probability === 'number') scores.set(id, answer.probability);
    }
    return scores;
  }
  const text = ((raw['output'] as { type: string; content?: { type: string; text?: string }[] }[] | undefined) ?? [])
    .flatMap((item) => item.type === 'message' ? item.content ?? [] : []).find((part) => part.type === 'output_text')?.text;
  const values = JSON.parse(text ?? '{}') as Record<string, unknown>;
  for (const [key, id] of byKey) {
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value)) scores.set(id, Math.min(1, Math.max(0, value)));
  }
  return scores;
}

async function send(path: string, text: string): Promise<JudgeReply> {
  const response = await fetch(`https://api.openai.com${path}`, {
    method: 'POST', body: text,
    headers: { authorization: `Bearer ${process.env['OPENAI_API_KEY'] ?? ''}`, 'content-type': 'application/json' },
  });
  try {
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected an object');
    return { status: response.status, raw: raw as Record<string, unknown> };
  } catch {
    return { status: response.status, raw: {}, error: 'unparsable response body' };
  }
}

async function judge(): Promise<void> {
  const runStarted = performance.now();
  const arm = values.arm ?? '';
  if (!['decisions', 'chat'].includes(arm) || values.model === undefined) throw new Error('judge needs --arm decisions|chat and --model');
  if (values['chunk-config'] === undefined) throw new Error('judge needs --chunk-config <trusted-config>');
  if (process.env['OPENAI_API_KEY'] === undefined) throw new Error('OPENAI_API_KEY is not set');
  const chunkConfig = loadConfiguration(values['chunk-config']).config;
  const limits = batchLimits(chunkConfig.provider.adapter ?? 'typesafe-direct');
  const cases = (await loadCases(poolPaths, mirrors)).slice(0, positiveInteger(values.cases, Number.MAX_SAFE_INTEGER));
  const results: Judged[] = await mapLimit(cases, positiveInteger(values.jobs, 4), async (entry) => {
    const caseStarted = performance.now();
    const items = entry.pool.candidates.map((candidate) => batchItem(entry.files, candidate));
    const chunks = planChunks(entry.pool.query, items, (batch) => serializeConfiguredBatch(chunkConfig, batch),
      (serialized) => fitsSerializedBatch(serialized, limits));
    const scores: Record<string, number> = {};
    const requests: JudgeRequest[] = [];
    for (const chunk of chunks) {
      const { path, json } = body(arm, values.model!, values.effort, entry.pool.query, chunk);
      const text = JSON.stringify(json);
      const judged = await judgeWithRetries({
        ids: chunk.map((item) => item.id), bytes: Buffer.byteLength(text),
        send: () => send(path, text), parse: (raw) => parse(arm, chunk, raw), now: () => performance.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      for (const [id, score] of judged.scores) scores[id] = score;
      requests.push(...judged.requests);
    }
    console.error(`${arm} ${values.model!} ${values.effort ?? '-'} ${entry.id}: ${String(items.length)} candidates, ${String(chunks.length)} chunks, ${String(requests.length)} attempts`);
    return { id: entry.id, scores, requests, wallMs: performance.now() - caseStarted };
  });
  const report = { schemaVersion: 1, kind: 'layout-judgments', layout: LAYOUT, arm, model: values.model, effort: values.effort ?? null,
    createdAt: new Date().toISOString(), environment: environment(), runWallMs: performance.now() - runStarted,
    accounting: 'all-attempts-and-case-walltime', chunkConfig: values['chunk-config'], cases: results };
  const failed = results.flatMap((entry) => entry.requests.filter((request) => request.error !== null));
  console.log(`Judgments: ${writeReport(values.output ?? `benchmark-results/openai-${arm}.json`, report)}; failed attempts ${String(failed.length)}`);
  for (const request of failed.slice(0, 3)) console.log(`  ${request.error ?? ''}`);
}

function quality(rows: readonly LayoutRow[]) {
  const positive = rows.filter((row) => row.kind === 'positive' && row.metrics !== null);
  const premise = rows.filter((row) => row.kind === 'false-premise' && row.metrics !== null);
  const pick = (set: readonly LayoutRow[], key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage') =>
    mean(set.flatMap((row) => row.metrics?.[key] == null ? [] : [row.metrics[key]!]));
  return {
    searches: rows.length, incomplete: rows.filter((row) => !row.complete).length,
    recallAt1: pick(positive, 'recallAt1'), recallAt5: pick(positive, 'recallAt5'), mrr: pick(positive, 'reciprocalRank'),
    counterCoverage: pick(premise, 'evidenceCoverage'),
    negativeAccuracy: mean(rows.flatMap((row) => row.negativeCorrect === null ? [] : [Number(row.negativeCorrect)])),
    excerpts: mean(rows.map((row) => row.excerpts)), unannotated: mean(rows.map((row) => row.unannotated)),
  };
}

async function compare(): Promise<void> {
  const paths = values.judgments?.split(',') ?? [];
  const labels = values.labels?.split(',') ?? paths;
  const prices = (values.prices?.split(';') ?? []).map((entry) => {
    const [input, cached, output] = entry.split(',').map(Number) as [number, number, number];
    if ([input, cached, output].some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('--prices needs non-negative input,cached,output rates');
    return { input, cached, output } satisfies JudgePrice;
  });
  const cases = await loadCases(poolPaths, mirrors);
  const fmt = (value: number | null | undefined, digits = 3): string => value == null || Number.isNaN(value) ? '-' : value.toFixed(digits);
  const rows = [];
  console.log('arm | R@1 | R@5 | MRR | counter | negatives | excerpts | incomplete | attempts | errors | known input tok | known output tok (reasoning) | unknown usage attempts | known USD subtotal | USD | USD/search | attempt ms p50 | attempt ms p95 | s/search | legacy timing cases');
  for (const [index, path] of paths.entries()) {
    const file = JSON.parse(readFileSync(path, 'utf8')) as { cases: Judged[] };
    const byId = new Map(file.cases.map((entry) => [entry.id, entry]));
    const judged = cases.filter((entry) => byId.has(entry.id));
    const scored = judged.map((entry) => scoreCase(entry, byId.get(entry.id)!.scores));
    const requests = file.cases.flatMap((entry) => entry.requests);
    const price = prices[index];
    const usage = summarizeJudgeUsage(requests, price);
    const timings = file.cases.map(judgeCaseTiming);
    const row = { label: labels[index], quality: quality(scored), requests: requests.length, errors: requests.filter((request) => request.error !== null).length,
      ...usage, usdPerSearch: usage.usd === null ? null : usage.usd / file.cases.length,
      msP50: quantile(requests.map((request) => request.ms), 0.5), msP95: quantile(requests.map((request) => request.ms), 0.95),
      secondsPerSearch: mean(timings.map((timing) => timing.ms / 1000)),
      legacyTimingCases: timings.filter((timing) => timing.source !== 'wall').length };
    const { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, usd } = usage;
    rows.push(row);
    if (row.legacyTimingCases > 0) console.error(`${labels[index] ?? path}: ${String(row.legacyTimingCases)} legacy cases use recorded-request timing lower bounds; unrecorded retries and backoff cannot be recovered.`);
    const q = row.quality;
    console.log([row.label, fmt(q.recallAt1), fmt(q.recallAt5), fmt(q.mrr), fmt(q.counterCoverage), fmt(q.negativeAccuracy), fmt(q.excerpts, 2),
      String(q.incomplete), String(row.requests), String(row.errors), String(input), `${String(output)} (${String(reasoning)})`,
      String(row.unknownUsageAttempts), fmt(row.knownUsd, 4), fmt(usd, 4), fmt(row.usdPerSearch, 5), fmt(row.msP50, 0), fmt(row.msP95, 0), fmt(row.secondsPerSearch, 2), String(row.legacyTimingCases)].join(' | '));
  }
  if (values.output !== undefined) writeReport(values.output, { environment: environment(), rows });
}

if (positionals[0] === 'judge') await judge();
else if (positionals[0] === 'compare') await compare();
else throw new Error('usage: bench-openai-judges.ts judge|compare');
