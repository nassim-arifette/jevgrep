/**
 * Second-stage re-ranking experiment: a stronger model orders the fragments JevGrep
 * scored above the threshold (captured candidate pools), and the top five of that order
 * are measured against the relevance order replayed on the same pools. No search is
 * re-run; only the re-ranking requests are made.
 *
 *   node scripts/bench-rerank.ts --captures a.json,b.json --mirrors <dir> [--model gpt-6.1-terra] [--effort medium] [--cap 80] [--dry-run] [--output report.json]
 */
import { parseArgs } from 'node:util';
import { environment, writeReport } from './bench/common.ts';
import { hardManifestPath, loadManifest } from './bench/real-tasks.ts';
import type { RealTask } from './bench/real-tasks.ts';
import { readCapture, replayPool } from './bench/replay.ts';
import { localizationRangeMetrics } from './bench/retrieval.ts';
import { loadSnapshots } from './bench/snapshots.ts';
import { mean } from './bench/report.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';

const { values } = parseArgs({ options: {
  captures: { type: 'string' }, mirrors: { type: 'string' }, manifest: { type: 'string' }, model: { type: 'string', default: 'gpt-6.1-terra' },
  effort: { type: 'string', default: 'medium' }, cap: { type: 'string', default: '80' }, top: { type: 'string', default: '5' },
  'dry-run': { type: 'boolean' }, output: { type: 'string' }, concurrency: { type: 'string', default: '4' }, only: { type: 'string' },
} });
if (values.captures === undefined || values.mirrors === undefined) throw new Error('--captures and --mirrors are required');
const cap = Number(values.cap);
const top = Number(values.top);
const manifest = loadManifest(values.manifest ?? hardManifestPath, {});
type Pool = ReturnType<typeof readCapture>['pools'][number];
const pools = new Map<string, Pool>();
for (const path of values.captures.split(',')) for (const entry of readCapture(path).pools) pools.set(entry.id, entry);
const tasks: RealTask[] = manifest.tasks.filter((task) => [...pools.values()].some((entry) => entry.source === task.id));
const snapshots = await loadSnapshots(tasks, values.mirrors);
const only = values.only === undefined ? null : new Set(values.only.split(','));

type Range = { path: string; start_line: number; end_line: number };
const sliceLines = (text: string, start: number, end: number): string => text.split('\n').slice(start - 1, end).join('\n');

type Case = { id: string; split: string; query: NonNullable<ReturnType<typeof queryOf>>; pool: Pool['pool']; files: Record<string, string> };
function queryOf(task: RealTask, id: string) { return task.queries.find((entry) => entry.id === id); }
const cases: Case[] = [];
for (const [id, entry] of pools) {
  if (only !== null && !only.has(id)) continue;
  const task = tasks.find((candidate) => candidate.id === entry.source);
  const query = task === undefined ? undefined : queryOf(task, id);
  if (task === undefined || query === undefined || query.evidence.length === 0) continue;
  cases.push({ id, split: task.split, query, pool: entry.pool, files: snapshots.get(task.id)! });
}
cases.sort((left, right) => (left.id < right.id ? -1 : 1));

function qualifying(entry: Case) {
  return entry.pool.candidates.filter((candidate) => candidate.score >= entry.pool.threshold)
    .sort((left, right) => (right.score - left.score) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || (left.startLine - right.startLine))
    .slice(0, cap);
}

function prompt(entry: Case) {
  const fragments = qualifying(entry);
  const corpus = fragments.map((fragment, index) => {
    const text = sliceLines(entry.files[fragment.path] ?? '', fragment.startLine, fragment.endLine)
      .split('\n').map((line, offset) => `${String(fragment.startLine + offset)}| ${line}`).join('\n');
    return `<fragment id="${String(index)}" path="${fragment.path}" lines="${String(fragment.startLine)}-${String(fragment.endLine)}">\n${text}\n</fragment>`;
  }).join('\n');
  return { fragments, input: `${corpus}\n\nQuestion: ${entry.query.query}` };
}

const instructions = 'You are the second stage of a code search tool. You receive code fragments that a first stage judged relevant to a question, '
  + `each with an id, its file path and 1-based line numbers, then the question. Return the ids of up to ${String(top)} fragments that best answer the question, best first: `
  + 'the code that would have to change or that explains the behaviour asked about. Return fewer ids when fewer fragments are relevant.';

async function rerank(entry: Case): Promise<{ ranges: Range[]; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cached: number | null }> {
  const { fragments, input } = prompt(entry);
  const body = JSON.stringify({
    model: values.model, store: false, ...(values.effort === 'none' ? {} : { reasoning: { effort: values.effort } }), instructions, input,
    text: { format: { type: 'json_schema', name: 'ranking', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', items: { type: 'integer' } } },
    } } },
  });
  let raw: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', body,
      headers: { authorization: `Bearer ${process.env['OPENAI_API_KEY'] ?? ''}`, 'content-type': 'application/json' } });
    raw = await response.json() as Record<string, unknown>;
    if (response.status === 200) break;
    if ((response.status === 429 || response.status >= 500) && attempt < 8) { await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 10_000 * (attempt + 1)))); continue; }
    throw new Error(`HTTP ${String(response.status)}: ${JSON.stringify(raw['error'] ?? null).slice(0, 300)}`);
  }
  const text = ((raw['output'] as { type: string; content?: { type: string; text?: string }[] }[] | undefined) ?? [])
    .flatMap((item) => item.type === 'message' ? item.content ?? [] : []).find((part) => part.type === 'output_text')?.text;
  const ids = (JSON.parse(text ?? '{"ids":[]}') as { ids: number[] }).ids;
  const ranges: Range[] = [];
  for (const id of ids) {
    const fragment = fragments[id];
    if (fragment === undefined || ranges.some((range) => range.path === fragment.path && range.start_line === fragment.startLine)) continue;
    ranges.push({ path: fragment.path, start_line: fragment.startLine, end_line: fragment.endLine });
    if (ranges.length >= top) break;
  }
  const usage = raw['usage'] as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined;
  return { ranges, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens ?? null };
}

if (values['dry-run'] === true) {
  let tokens = 0;
  for (const entry of cases) { const { fragments, input } = prompt(entry); const count = countReferenceTokens(input); tokens += count; console.log(`${entry.id} ${String(fragments.length)} fragments ${String(count)} tokens`); }
  console.log(`cases ${String(cases.length)}; prompt tokens ${String(tokens)}`);
  process.exit(0);
}

type Row = { id: string; split: string; qualifying: number; baseline: ReturnType<typeof localizationRangeMetrics>; rerank: ReturnType<typeof localizationRangeMetrics>; usage: Awaited<ReturnType<typeof rerank>> extends infer R ? Omit<R, 'ranges'> : never; ranges: Range[] };
const rows: Row[] = [];
const queue = [...cases];
async function worker(): Promise<void> {
  for (;;) {
    const entry = queue.shift();
    if (entry === undefined) return;
    const replay = replayPool(entry.pool, entry.files, { policy: 'relevance' });
    const baseline = localizationRangeMetrics(entry.query, replay.result.excerpts);
    const started = performance.now();
    try {
      const { ranges, ...usage } = await rerank(entry);
      const metrics = localizationRangeMetrics(entry.query, ranges);
      rows.push({ id: entry.id, split: entry.split, qualifying: qualifying(entry).length, baseline, rerank: metrics, usage, ranges });
      console.log(`${entry.id} base R@5=${String(baseline.recallAt5)} rerank R@5=${String(metrics.recallAt5)} in ${String(Math.round(performance.now() - started) / 1000)} s, ${String(usage.inputTokens)} tokens`);
    } catch (error) {
      console.log(`${entry.id} failed: ${String(error)}`);
    }
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, () => worker()));
const pick = (list: Row[], side: 'baseline' | 'rerank', key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage') =>
  mean(list.map((row) => row[side][key]).filter((value): value is number => value !== null));
const summary = Object.fromEntries(['dev', 'heldout', 'all'].map((split) => {
  const list = rows.filter((row) => split === 'all' || row.split === split);
  return [split, { searches: list.length,
    baseline: { recallAt1: pick(list, 'baseline', 'recallAt1'), recallAt5: pick(list, 'baseline', 'recallAt5'), mrr: pick(list, 'baseline', 'reciprocalRank'), coverage: pick(list, 'baseline', 'evidenceCoverage') },
    rerank: { recallAt1: pick(list, 'rerank', 'recallAt1'), recallAt5: pick(list, 'rerank', 'recallAt5'), mrr: pick(list, 'rerank', 'reciprocalRank'), coverage: pick(list, 'rerank', 'evidenceCoverage') },
    inputTokens: list.reduce((total, row) => total + (row.usage.inputTokens ?? 0), 0), outputTokens: list.reduce((total, row) => total + (row.usage.outputTokens ?? 0), 0) }];
}));
console.log(JSON.stringify(summary, null, 1));
if (values.output !== undefined) console.log(writeReport(values.output, { kind: 'rerank', model: values.model, effort: values.effort, cap, top, environment: environment(), summary, rows }));
