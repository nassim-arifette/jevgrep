import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { createDefaultConfiguration } from '../src/config.ts';
import type { Configuration } from '../src/contracts.ts';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import { JevAdapter } from '../src/evaluation/jev.ts';
import { bootstrapMeanDifference } from './bench/agent.ts';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import { adjacentCandidates, expandCandidates, fragmentsOf, loadCodeGraph, type Candidate, type CodeGraph } from './bench/graph.ts';
import { bm25Scores, stop, terms } from './bench/lexical.ts';
import { liveProvider } from './bench/live-provider.ts';
import { ensureMirror, exportSnapshot, loadManifest, mapLimit, systemsManifestPath, type RealQuery, type RealTask } from './bench/real-tasks.ts';
import { candidateCost, capturingProvider, emptyPool, itemKey, loadPool, replayProvider, sha256, type PoolItem, type ScorePool } from './bench/score-pool.ts';
import { groupBy, latencySummary, mean } from './bench/report.ts';
import { covered, localizationRangeMetrics, type Range } from './bench/retrieval.ts';
import { loadSnapshots } from './bench/snapshots.ts';

const run = promisify(execFile);
const replayArms = ['jevgrep-replay', 'e7-hop0', 'e7-adjacent', 'e7-hop1', 'e7-hop2', 'codegraph-jevgrep'] as const;
const arms = ['ripgrep', 'bm25', 'codegraph-query', 'codegraph-context', 'laya', 'jevgrep', 'openai-solo', ...replayArms] as const;
type Arm = typeof arms[number];

const { values } = parseArgs({ options: {
  arms: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, mirrors: { type: 'string' },
  codegraph: { type: 'string' }, 'laya-url': { type: 'string' }, jobs: { type: 'string' }, 'provider-jobs': { type: 'string' },
  'max-requests': { type: 'string' }, 'response-tokens': { type: 'string' }, top: { type: 'string' }, help: { type: 'boolean' },
  capture: { type: 'string' }, replay: { type: 'string' }, budget: { type: 'string' }, seeds: { type: 'string' },
  fanout: { type: 'string' }, 'graph-behind': { type: 'string' }, 'usd-per-million': { type: 'string' }, 'go-rust': { type: 'boolean' },
  'openai-model': { type: 'string' }, 'openai-effort': { type: 'string' }, queries: { type: 'string' }, only: { type: 'string' },
} });

if (values.help) {
  console.log([
    'npm run bench:compare -- --arms ripgrep,bm25,codegraph-query,codegraph-context,laya [--codegraph <bin>] [--laya-url http://127.0.0.1:8765]',
    'npm run bench:compare -- --arms jevgrep --config <trusted-config> [--provider-jobs 1] [--capture <score-pool.json>]',
    'npm run bench:compare -- --arms jevgrep-replay,e7-hop0,e7-adjacent,e7-hop1,e7-hop2,codegraph-jevgrep --replay <score-pool.json> [--budget 16] [--seeds 8] [--fanout 4] [--graph-behind <commits>]',
    'npm run bench:compare -- --arms openai-solo --openai-model gpt-6-luna [--openai-effort none|medium]   (model alone, whole snapshot in context; needs OPENAI_API_KEY)',
    'Replay arms reuse captured Jev scores offline: candidate arms only let Jev "evaluate" the fragments they propose, under one fragment budget.',
    'Every arm answers the same pinned real-task queries; ranked ranges are scored with identical metrics.',
  ].join('\n'));
  process.exit(0);
}

const selected = (values.arms ?? 'ripgrep,bm25,codegraph-query,codegraph-context').split(',') as Arm[];
for (const arm of selected) if (!arms.includes(arm)) throw new Error(`unknown arm ${arm}`);
const top = positiveInteger(values.top, 10);
const responseTokens = positiveInteger(values['response-tokens'], 4_000);
const codegraphBin = values.codegraph ?? 'codegraph';
const layaUrl = values['laya-url'] ?? 'http://127.0.0.1:8765';
const budget = positiveInteger(values.budget, 16);
const seedCount = positiveInteger(values.seeds, Math.max(1, Math.floor(budget / 2)));
const fanout = positiveInteger(values.fanout, 4);
const graphBehind = values['graph-behind'] === undefined ? 0 : positiveInteger(values['graph-behind'], 1);
// Vercel AI Gateway list price for typesafe-ai/jev input, read from its model listing on 2026-11-03.
const usdPerMillion = Number(values['usd-per-million'] ?? 0.042);
if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) throw new Error('--usd-per-million must be a non-negative number');
if (selected.includes('jevgrep') && selected.some((arm) => (replayArms as readonly string[]).includes(arm))) throw new Error('run live and replay arms separately');
if (values.capture !== undefined && !selected.includes('jevgrep')) throw new Error('--capture requires the jevgrep arm');
const pool: ScorePool | null = values.replay === undefined ? null : loadPool(values.replay);
if (pool === null && selected.some((arm) => (replayArms as readonly string[]).includes(arm))) throw new Error('replay arms require --replay <score-pool.json>');
const graphArms = new Set<Arm>(['codegraph-query', 'codegraph-context', 'e7-hop1', 'e7-hop2', 'codegraph-jevgrep']);

type Answer = { readonly ranges: readonly Range[]; readonly complete: boolean; readonly returnedChars: number; readonly detail?: unknown };
type GraphIndex = { root: string; coldMs: number; dbBytes: number; syncMs?: number; stats?: CodeGraph['stats']; graph?: CodeGraph };
type Tree = { readonly root: string; readonly files: Readonly<Record<string, string>>; readonly indexMs: Partial<Record<Arm, number>>; graphIndex?: GraphIndex | undefined };

/** Non-overlapping line windows per file, so a hit covers a function-sized region. */
function windows(files: Readonly<Record<string, string>>, size = 40, stride = 20) {
  const out: { path: string; start: number; end: number; tokens: string[] }[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/\.(py|pyi|js|ts|java|go|rs|rst|txt|cfg|toml|md)$/.test(path)) continue;
    const lines = text.split('\n');
    for (let start = 0; start < lines.length; start += stride) {
      const end = Math.min(lines.length, start + size);
      out.push({ path, start: start + 1, end, tokens: terms(lines.slice(start, end).join('\n')) });
      if (end === lines.length) break;
    }
  }
  return out;
}

/** Keep the best window of each overlapping group, best first. */
function suppress(scored: { path: string; start: number; end: number; score: number }[]): Range[] {
  const kept: Range[] = [];
  for (const window of scored.sort((a, b) => b.score - a.score)) {
    if (window.score <= 0) break;
    if (kept.some((range) => range.path === window.path && range.start_line <= window.end && range.end_line >= window.start)) continue;
    kept.push({ path: window.path, start_line: window.start, end_line: window.end });
    if (kept.length >= top) break;
  }
  return kept;
}

const charsOf = (tree: Tree, ranges: readonly Range[]): number => ranges.reduce((sum, range) =>
  sum + (tree.files[range.path] ?? '').split('\n').slice(range.start_line - 1, range.end_line).join('\n').length, 0);

const bm25Index = new Map<string, { docs: ReturnType<typeof windows>; df: Map<string, number>; avg: number }>();
function bm25(tree: Tree, query: string): Answer {
  let index = bm25Index.get(tree.root);
  if (index === undefined) {
    const started = performance.now();
    const docs = windows(tree.files);
    const df = new Map<string, number>();
    for (const doc of docs) for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    index = { docs, df, avg: mean(docs.map((doc) => doc.tokens.length)) ?? 1 };
    bm25Index.set(tree.root, index);
    tree.indexMs.bm25 = performance.now() - started;
  }
  const q = [...new Set(terms(query).filter((term) => !stop.has(term)))];
  const { docs, df, avg } = index;
  const scored = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (docs.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.tokens.length / avg));
    }
    return { path: doc.path, start: doc.start, end: doc.end, score };
  });
  const ranges = suppress(scored);
  return { ranges, complete: true, returnedChars: charsOf(tree, ranges) };
}

/** What an agent does first: grep the identifiers the question names, rank windows by distinct hits. */
async function ripgrep(tree: Tree, query: string): Promise<Answer> {
  const named = [...new Set((query.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [])
    .flatMap((word) => word.split('.'))
    .filter((word) => word.length >= 4 && !stop.has(word.toLowerCase()) && (/[_A-Z]/.test(word.slice(1)) || /[a-z][A-Z]/.test(word) || word.includes('_') || !/^[A-Z]?[a-z]+$/.test(word) || word.length >= 8)))];
  if (named.length === 0) return { ranges: [], complete: true, returnedChars: 0, detail: { terms: [] } };
  // `/` separators on every platform: Windows rg prints `.\dir\file` by default.
  const args = ['-n', '--no-heading', '-i', '-w', '-F', '--path-separator', '/', ...named.flatMap((term) => ['-e', term]), '.'];
  const { stdout } = await run('rg', args, { cwd: tree.root, maxBuffer: 1 << 28 }).catch((cause: { code?: unknown; stdout?: string }) => {
    // rg exits 1 when nothing matches; a missing binary or any other failure is an error, not an empty answer.
    if (cause.code === 1) return { stdout: cause.stdout ?? '' };
    throw cause;
  });
  const hits = new Map<string, { line: number; text: string }[]>();
  for (const row of stdout.split('\n')) {
    const match = /^\.\/(.+?):(\d+):(.*)$/.exec(row);
    if (match === null) continue;
    const list = hits.get(match[1]!) ?? [];
    list.push({ line: Number(match[2]), text: match[3]!.toLowerCase() });
    hits.set(match[1]!, list);
  }
  const scored: { path: string; start: number; end: number; score: number }[] = [];
  for (const [path, list] of hits) {
    for (const hit of list) {
      const start = Math.max(1, hit.line - 20);
      const end = hit.line + 20;
      const near = list.filter((other) => other.line >= start && other.line <= end);
      const distinct = named.filter((term) => near.some((other) => other.text.includes(term.toLowerCase()))).length;
      scored.push({ path, start, end, score: distinct + near.length / 1000 });
    }
  }
  const ranges = suppress(scored);
  return { ranges, complete: true, returnedChars: charsOf(tree, ranges), detail: { terms: named } };
}

type CodeNode = { readonly filePath: string; readonly startLine: number; readonly endLine: number };
async function codegraph(tree: Tree, query: string, mode: 'query' | 'context'): Promise<Answer> {
  const text = query.slice(0, 2_000);
  const args = mode === 'query' ? ['query', text, '--json', '--limit', String(top)] : ['context', text, '--format', 'json', '-n', String(top)];
  const { stdout } = await run(codegraphBin, args, { cwd: tree.root, maxBuffer: 1 << 28, env: { ...process.env, DO_NOT_TRACK: '1' } });
  const parsed: unknown = JSON.parse(stdout);
  const nodes: CodeNode[] = mode === 'query'
    ? (parsed as { node: CodeNode }[]).map((row) => row.node)
    : (parsed as { codeBlocks: CodeNode[] }).codeBlocks;
  const ranges = nodes.slice(0, top).map((node) => ({ path: node.filePath, start_line: node.startLine, end_line: node.endLine }));
  return { ranges, complete: true, returnedChars: charsOf(tree, ranges) };
}

async function engineSearch(tree: Tree, query: RealQuery, provider: ProviderClient, configure: (base: Configuration) => Configuration): Promise<Answer> {
  const space = workspace(tree.files, configure);
  try {
    const result = await createSearchEngine({ configuration: space.loaded, provider }).search({
      query: query.query, scope: ['.'], max_context_tokens: responseTokens,
    }, { searchId: query.id });
    const outcome = result.outcome;
    if (!('report' in outcome)) return { ranges: [], complete: false, returnedChars: 0, detail: outcome.error };
    return {
      ranges: outcome.excerpts, complete: outcome.status === 'complete' && outcome.report.scope_fully_scanned,
      returnedChars: outcome.excerpts.reduce((sum, excerpt) => sum + excerpt.code.length, 0),
      detail: { status: outcome.status, stop: outcome.report.stop_reasons, usage: outcome.report.usage, measuredTokens: result.measuredTokens },
    };
  } finally {
    space.cleanup();
  }
}

/**
 * A model alone, without JevGrep: the whole snapshot (every file the other arms see,
 * with line numbers) goes into one OpenAI Responses request, and the model returns up
 * to `top` locations, best first. Files come first so repeated questions on one
 * snapshot can reuse the provider's prompt cache.
 */
async function openaiSolo(tree: Tree, task: RealTask, query: string): Promise<Answer> {
  const model = values['openai-model'];
  if (model === undefined || process.env['OPENAI_API_KEY'] === undefined) throw new Error('openai-solo needs --openai-model and OPENAI_API_KEY');
  const corpus = Object.keys(tree.files).sort().map((path) => {
    const numbered = (tree.files[path] ?? '').split('\n').map((line, index) => `${String(index + 1)}| ${line}`).join('\n');
    return `<file path="${path}">\n${numbered}\n</file>`;
  }).join('\n');
  const body = JSON.stringify({
    model, store: false, prompt_cache_key: `jevgrep-solo-${task.id}`,
    ...(values['openai-effort'] === undefined ? {} : { reasoning: { effort: values['openai-effort'] } }),
    instructions: 'You are a code search tool. You receive every file of a repository with 1-based line numbers, then a question. '
      + `Return up to ${String(top)} source locations that best answer the question, best first. Each location is a file path exactly as `
      + 'given and an inclusive line range of a function-sized region (at most about 60 lines). Prefer implementation, conditions, data '
      + 'flow, configuration and tests relevant to the question. Return an empty list if nothing in the repository answers it.',
    input: `${corpus}\n\nQuestion: ${query}`,
    text: { format: { type: 'json_schema', name: 'locations', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['locations'],
      properties: { locations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'start_line', 'end_line'],
        properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } } } } },
    } } },
  });
  let raw: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', body,
      headers: { authorization: `Bearer ${process.env['OPENAI_API_KEY']}`, 'content-type': 'application/json' } });
    raw = await response.json() as Record<string, unknown>;
    if (response.status === 200) break;
    // Whole-snapshot requests are large; a token-per-minute limit resets within about a minute.
    if ((response.status === 429 || response.status >= 500) && attempt < 12) { await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 10_000 * (attempt + 1)))); continue; }
    throw new Error(`HTTP ${String(response.status)}: ${JSON.stringify(raw['error'] ?? null).slice(0, 300)}`);
  }
  const text = ((raw['output'] as { type: string; content?: { type: string; text?: string }[] }[] | undefined) ?? [])
    .flatMap((item) => item.type === 'message' ? item.content ?? [] : []).find((part) => part.type === 'output_text')?.text;
  const located = (JSON.parse(text ?? '{"locations":[]}') as { locations: { path: string; start_line: number; end_line: number }[] }).locations;
  const ranges: Range[] = [];
  for (const location of located) {
    const lines = tree.files[location.path]?.split('\n').length;
    if (lines === undefined) continue;
    const start = Math.max(1, Math.min(location.start_line, lines));
    ranges.push({ path: location.path, start_line: start, end_line: Math.max(start, Math.min(location.end_line, lines)) });
    if (ranges.length >= top) break;
  }
  const usage = raw['usage'] as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number } } | undefined;
  return { ranges, complete: true, returnedChars: charsOf(tree, ranges), detail: {
    model, effort: values['openai-effort'] ?? null, invalidLocations: located.length - ranges.length,
    usage: { inputTokens: usage?.input_tokens ?? null, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null, reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null },
  } };
}

const manifest = values['go-rust'] ? loadManifest(systemsManifestPath, {}) : loadManifest();
const tasks = manifest.tasks;
const snapshots = await loadSnapshots(tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
const scratch = mkdtempSync(join(tmpdir(), 'jevgrep-compare-'));
const trees = new Map<string, Tree>();
for (const task of tasks) {
  const root = join(scratch, task.id);
  const files = snapshots.get(task.id)!;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  trees.set(task.id, { root, files, indexMs: {} });
}

const jobs = positiveInteger(values.jobs, availableParallelism());
const graphEnv = { ...process.env, DO_NOT_TRACK: '1' };
const dbPath = (root: string): string => join(root, '.codegraph/codegraph.db');
const mirrorRoot = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
if (selected.some((arm) => graphArms.has(arm))) {
  await mapLimit(tasks, jobs, async (task) => {
    const tree = trees.get(task.id)!;
    // A stale index is built from an older commit and then queried against the current snapshot.
    let root = tree.root;
    if (graphBehind > 0) {
      root = join(scratch, 'stale', task.id);
      const files = await exportSnapshot(await ensureMirror(mirrorRoot, task.repository), task.repository, `${task.baseCommit}~${graphBehind}`);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
    }
    const started = performance.now();
    await run(codegraphBin, ['init', '.'], { cwd: root, maxBuffer: 1 << 26, env: graphEnv });
    const coldMs = performance.now() - started;
    tree.graphIndex = { root, coldMs, dbBytes: statSync(dbPath(root)).size };
    for (const arm of graphArms) if (selected.includes(arm)) tree.indexMs[arm] = coldMs;
  });
}

/** Load the graph once per tree; a missing or unreadable index falls back to lexical candidates. */
function graphOf(tree: Tree): CodeGraph | null {
  const index = tree.graphIndex;
  if (index === undefined) return null;
  if (index.graph === undefined) {
    try {
      index.graph = loadCodeGraph(dbPath(index.root));
      index.stats = index.graph.stats;
    } catch (cause) {
      console.error(`graph unavailable for ${tree.root}: ${String(cause).slice(0, 200)}`);
      tree.graphIndex = undefined;
      return null;
    }
  }
  return index.graph;
}

const live = selected.includes('jevgrep')
  ? liveProvider(values.config ?? (() => { throw new Error('--config is required for the jevgrep arm'); })(), {
    requests: positiveInteger(values['max-requests'], 400), estimatedInputTokens: 4_000_000,
  })
  : null;
const capture = values.capture !== undefined && live !== null ? emptyPool(live.template.config) : null;
const replayConfig = pool === null ? null : { ...createDefaultConfiguration('/', pool.provider.model), provider: pool.provider, search: pool.search };
const replayConfigure = (base: Configuration): Configuration => ({
  ...base, remote_evaluation_enabled: true, provider: pool!.provider, search: pool!.search, cache: { ...base.cache, enabled: false },
});

/** Fixed lexical ranking of the pool's fragments: the same E7 input for every hop count. */
const rankCache = new Map<string, PoolItem[]>();
function lexicalRank(tree: Tree, query: RealQuery, items: readonly PoolItem[]): PoolItem[] {
  const cached = rankCache.get(query.id);
  if (cached !== undefined) return cached;
  const docs = items.map((item) => terms((tree.files[item.path] ?? '').split('\n').slice(item.startLine - 1, item.endLine).join('\n')));
  const scores = bm25Scores(docs, query.query);
  const order = items.map((item, index) => ({ item, score: scores[index]! }))
    .sort((a, b) => b.score - a.score || (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : a.item.startLine - b.item.startLine))
    .map((entry) => entry.item);
  rankCache.set(query.id, order);
  return order;
}

type ContextBlock = { readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly nodeKind?: string };
/** CodeGraph's own context retrieval proposes the candidates; lexical ranking fills unused allowance. */
async function graphToolCandidates(tree: Tree, query: RealQuery, ranked: readonly PoolItem[]): Promise<Candidate[]> {
  const chosen: Candidate[] = [];
  const taken = new Set<PoolItem>();
  const take = (item: PoolItem, origin: Candidate['origin']): void => {
    if (chosen.length < budget && !taken.has(item)) { taken.add(item); chosen.push({ item, origin }); }
  };
  if (graphOf(tree) !== null) {
    try {
      const { stdout } = await run(codegraphBin, ['context', query.query.slice(0, 2_000), '--format', 'json', '-n', String(budget)],
        { cwd: tree.graphIndex!.root, maxBuffer: 1 << 28, env: graphEnv });
      const blocks = (JSON.parse(stdout) as { codeBlocks?: ContextBlock[] }).codeBlocks ?? [];
      for (const block of blocks) {
        const node = { id: '', name: '', qualifiedName: '', kind: block.nodeKind ?? 'function', path: block.filePath, startLine: block.startLine, endLine: block.endLine };
        for (const item of fragmentsOf(node, ranked)) take(item, 'graph-tool');
      }
    } catch (cause) {
      console.error(`codegraph context failed for ${query.id}: ${String(cause).slice(0, 200)}`);
    }
  }
  for (const item of ranked) take(item, 'lexical');
  return chosen;
}

async function replayAnswer(arm: Arm, tree: Tree, query: RealQuery): Promise<Answer> {
  const entry = pool!.queries[query.id];
  if (entry === undefined || entry.questionSha256 !== sha256(query.query)) throw new Error('query missing from the score pool');
  const started = performance.now();
  const ranked = lexicalRank(tree, query, entry.items);
  const candidates: Candidate[] | null = arm === 'jevgrep-replay' ? null
    : arm === 'codegraph-jevgrep' ? await graphToolCandidates(tree, query, ranked)
    : arm === 'e7-adjacent' ? adjacentCandidates(ranked, { budget, seeds: seedCount })
    : expandCandidates(ranked, arm === 'e7-hop0' ? null : graphOf(tree), {
      budget, seeds: seedCount, hops: arm === 'e7-hop0' ? 0 : arm === 'e7-hop1' ? 1 : 2, fanout,
    });
  const selectMs = performance.now() - started;
  const items = candidates?.map((candidate) => candidate.item) ?? entry.items;
  const { provider, account } = replayProvider(pool!, entry, replayConfig!, candidates === null ? null : new Set(items.map(itemKey)));
  const result = await engineSearch(tree, query, provider, replayConfigure);
  const cost = candidateCost(entry, items);
  const ranges = items.map((item) => ({ path: item.path, start_line: item.startLine, end_line: item.endLine }));
  const origins: Record<string, number> = {};
  for (const candidate of candidates ?? []) origins[candidate.origin] = (origins[candidate.origin] ?? 0) + 1;
  return {
    ...result,
    complete: result.complete && account.missing === 0,
    detail: {
      ...(result.detail as object), candidates: items.length, origins, missingScores: account.missing, selectMs,
      candidateRecall: query.evidence.length === 0 ? null : query.evidence.filter((unit) => covered(unit, ranges)).length / query.evidence.length,
      jevBatches: cost.batches, jevInputTokens: cost.tokens, jevUsd: cost.tokens * usdPerMillion / 1e6,
      // Provider time is modeled from the captured live run; the replay itself makes no request.
      modeledJevMs: entry.requests === 0 ? 0 : cost.batches * entry.providerMs / entry.requests,
    },
  };
}
const laya = new JevAdapter({ model: 'english', baseUrl: layaUrl, apiKey: 'local' });
const layaConfigure = (base: Configuration): Configuration => ({
  ...base, remote_evaluation_enabled: true,
  search: { ...base.search, concurrency: 2, deadline_ms: 900_000 }, cache: { ...base.cache, enabled: false },
});

const queries = tasks.flatMap((task) => task.queries.map((query) => ({ task, query }))).slice(0, positiveInteger(values.queries, Number.MAX_SAFE_INTEGER))
  .filter(({ query }) => values.only === undefined || values.only.split(',').includes(query.id));
type Row = {
  arm: Arm; id: string; task: string; repository: string; split: string; category: string;
  latencyMs: number; complete: boolean; returnedChars: number; ranges: readonly Range[];
  metrics: ReturnType<typeof localizationRangeMetrics> | null; error: string | null; detail?: unknown;
};

async function answer(arm: Arm, task: RealTask, query: RealQuery): Promise<Row> {
  const tree = trees.get(task.id)!;
  const started = performance.now();
  const base = { arm, id: query.id, task: task.id, repository: task.repository, split: task.split, category: query.category };
  try {
    const result = arm === 'bm25' ? bm25(tree, query.query)
      : arm === 'ripgrep' ? await ripgrep(tree, query.query)
      : arm === 'codegraph-query' ? await codegraph(tree, query.query, 'query')
      : arm === 'codegraph-context' ? await codegraph(tree, query.query, 'context')
      : arm === 'laya' ? await engineSearch(tree, query, laya, layaConfigure)
      : arm === 'openai-solo' ? await openaiSolo(tree, task, query.query)
      : arm === 'jevgrep' ? await engineSearch(tree, query,
        capture === null ? live!.provider : capturingProvider(live!.provider, live!.template.config, capture, query.id), (b) => live!.configure(b))
      : await replayAnswer(arm, tree, query);
    const latencyMs = performance.now() - started;
    const ranges = result.ranges.map((range) => ({ path: range.path, start_line: range.start_line, end_line: range.end_line }));
    console.error(`${arm} ${query.id} ${result.complete ? 'complete' : 'incomplete'} ${Math.round(latencyMs)}ms`);
    return { ...base, latencyMs, complete: result.complete, returnedChars: result.returnedChars, ranges,
      metrics: result.complete ? localizationRangeMetrics(query, ranges) : null, error: null, detail: result.detail };
  } catch (cause) {
    console.error(`${arm} ${query.id} error ${String(cause).slice(0, 200)}`);
    return { ...base, latencyMs: performance.now() - started, complete: false, returnedChars: 0, ranges: [], metrics: null, error: String(cause).slice(0, 500) };
  }
}

const perArm = await Promise.all(selected.map((arm) => mapLimit(queries,
  arm === 'jevgrep' ? positiveInteger(values['provider-jobs'], 1) : arm === 'laya' ? 3 : arm === 'openai-solo' ? positiveInteger(values['provider-jobs'], 3) : jobs,
  ({ task, query }) => answer(arm, task, query))));
const rows = perArm.flat();

// Update cost: touch one evidence file per task, then time an incremental `codegraph sync`.
for (const task of tasks) {
  const index = trees.get(task.id)!.graphIndex;
  const target = task.queries[0]?.evidence[0]?.path;
  if (index === undefined || target === undefined) continue;
  const file = join(index.root, target);
  try {
    writeFileSync(file, `${(trees.get(task.id)!.files[target] ?? '')}\n# jevgrep e7 update probe\n`);
    const started = performance.now();
    await run(codegraphBin, ['sync', '.'], { cwd: index.root, maxBuffer: 1 << 26, env: graphEnv });
    index.syncMs = performance.now() - started;
  } catch (cause) {
    console.error(`codegraph sync failed for ${task.id}: ${String(cause).slice(0, 200)}`);
  }
}
const graphIndexes = Object.fromEntries([...trees].flatMap(([id, tree]) => tree.graphIndex === undefined ? []
  : [[id, { coldMs: tree.graphIndex.coldMs, syncMs: tree.graphIndex.syncMs ?? null, dbBytes: tree.graphIndex.dbBytes, stats: tree.graphIndex.stats ?? null }]]));
const crossFile = (row: Row): string => {
  const query = queries.find((entry) => entry.query.id === row.id)?.query;
  return new Set(query?.evidence.map((unit) => unit.path) ?? []).size > 1 ? 'multi-file' : 'single-file';
};

function summarize(group: readonly Row[]) {
  const done = group.filter((row) => row.metrics !== null);
  const pick = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'fileRecall' | 'complementaryCoverage') =>
    mean(done.flatMap((row) => row.metrics![key] == null ? [] : [row.metrics![key]!]));
  const top5 = (row: Row) => row.ranges.slice(0, 5);
  return {
    planned: group.length, complete: done.length, completionRate: group.length === 0 ? null : done.length / group.length,
    recallAt1: pick('recallAt1'), recallAt5: pick('recallAt5'), mrr: pick('reciprocalRank'),
    fileRecall: pick('fileRecall'), complementaryCoverage: pick('complementaryCoverage'),
    // Unanswered queries count as misses here, so incomplete arms cannot look better by skipping hard cases.
    recallAt5OverPlanned: group.length === 0 ? null : done.reduce((sum, row) => sum + (row.metrics!.recallAt5 ?? 0), 0) / group.length,
    returnedLinesTop5: mean(done.map((row) => top5(row).reduce((sum, range) => sum + range.end_line - range.start_line + 1, 0))),
    returnedChars: mean(done.map((row) => row.returnedChars)),
    latencyMs: latencySummary(group.map((row) => row.latencyMs)),
    ...jevSummary(done),
  };
}

type ReplayDetail = { candidates: number; candidateRecall: number | null; jevInputTokens: number; jevUsd: number; jevBatches: number;
  modeledJevMs: number; selectMs: number; origins: Record<string, number> };
function jevSummary(done: readonly Row[]) {
  const details = done.flatMap((row) => typeof row.detail === 'object' && row.detail !== null && 'jevInputTokens' in row.detail ? [row.detail as ReplayDetail] : []);
  if (details.length === 0) return {};
  const origins: Record<string, number> = {};
  for (const detail of details) for (const [key, n] of Object.entries(detail.origins)) origins[key] = (origins[key] ?? 0) + n;
  return {
    candidates: mean(details.map((detail) => detail.candidates)),
    candidateRecall: mean(details.flatMap((detail) => detail.candidateRecall === null ? [] : [detail.candidateRecall])),
    jevInputTokens: mean(details.map((detail) => detail.jevInputTokens)),
    jevBatches: mean(details.map((detail) => detail.jevBatches)),
    jevUsdTotal: details.reduce((sum, detail) => sum + detail.jevUsd, 0),
    modeledJevMs: mean(details.map((detail) => detail.modeledJevMs)),
    selectMs: latencySummary(details.map((detail) => detail.selectMs)),
    origins,
  };
}

const summary = Object.fromEntries(selected.map((arm) => {
  const group = rows.filter((row) => row.arm === arm);
  const indexes = [...trees.values()].flatMap((tree) => tree.indexMs[arm] === undefined ? [] : [tree.indexMs[arm]!]);
  return [arm, {
    overall: summarize(group), indexMs: latencySummary(indexes),
    byCategory: Object.fromEntries([...groupBy(group, (row) => row.category)].map(([key, g]) => [key, summarize(g)])),
    byRepository: Object.fromEntries([...groupBy(group, (row) => row.repository)].map(([key, g]) => [key, summarize(g)])),
    byEvidenceSpread: Object.fromEntries([...groupBy(group, crossFile)].map(([key, g]) => [key, summarize(g)])),
  }];
}));

/** Paired per-query differences against the no-expansion arm, resampled by task. */
const pairedBaseline: Arm = 'e7-hop0';
const paired = !selected.includes(pairedBaseline) ? null : Object.fromEntries(selected.filter((arm) => arm !== pairedBaseline).map((arm) => {
  const metric = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank') => {
    const clusters = [...groupBy(queries, (entry) => entry.task.id).values()].map((group) => group.flatMap(({ query }) => {
      const a = rows.find((row) => row.arm === arm && row.id === query.id)?.metrics?.[key];
      const b = rows.find((row) => row.arm === pairedBaseline && row.id === query.id)?.metrics?.[key];
      return a == null || b == null ? [] : [a - b];
    }));
    return { ...bootstrapMeanDifference(clusters), better: clusters.flat().filter((d) => d > 0).length, worse: clusters.flat().filter((d) => d < 0).length };
  };
  return [`${arm} - ${pairedBaseline}`, { recallAt1: metric('recallAt1'), recallAt5: metric('recallAt5'), mrr: metric('reciprocalRank') }];
}));

const report = {
  schemaVersion: 1, kind: 'retriever-comparison', createdAt: new Date().toISOString(), environment: environment(),
  dataset: { version: manifest.version, source: manifest.source, tasks: tasks.length, queries: queries.length },
  settings: {
    arms: selected, top, responseTokens, codegraph: codegraphBin, layaUrl, jevgrep: live?.settings ?? null,
    replay: pool === null ? null : { createdAt: pool.createdAt, model: pool.provider.model, budget, seeds: seedCount, fanout, graphBehind, usdPerMillion },
  },
  semantics: {
    ranking: 'each arm returns ranked line ranges; the same localization metrics score every arm',
    recallAt5OverPlanned: 'incomplete or failed queries count as zero',
    returned: 'context size delivered to the caller: lines in the top 5 ranges and characters of all returned ranges',
    labels: 'patch sites and quoted-docstring functions; not exhaustive relevance',
    replay: 'captured Jev scores per fragment; candidate arms mask every other fragment, so Jev work is the candidate set only',
    candidateRecall: 'share of required evidence units fully inside the evaluated candidate fragments (an upper bound on what Jev can return)',
    jevInputTokens: 'reference-token estimate for evaluating the candidate set alone, batched like the engine',
  },
  usage: live?.usage ?? null, graphIndexes, summary, paired, rows,
};
const path = writeReport(values.output ?? 'benchmark-results/compare.json', report);
if (capture !== null) console.log(`Score pool: ${writeReport(values.capture!, capture)}`);
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([arm, s]) => [arm, { ...s.overall, indexMs: s.indexMs.median }])), null, 1));
console.log(`Report: ${path}`);
