import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { Configuration } from '../src/contracts.ts';
import { createSearchEngine } from '../src/engine.ts';
import { JevAdapter, type ProviderClient } from '../src/evaluation/jev.ts';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import { liveProvider } from './bench/live-provider.ts';
import { loadManifest, mapLimit, type RealQuery, type RealTask } from './bench/real-tasks.ts';
import { groupBy, latencySummary, mean } from './bench/report.ts';
import { localizationRangeMetrics, type Range } from './bench/retrieval.ts';
import { loadSnapshots } from './bench/snapshots.ts';

const run = promisify(execFile);
const arms = ['ripgrep', 'bm25', 'codegraph-query', 'codegraph-context', 'laya', 'jevgrep'] as const;
type Arm = typeof arms[number];

const { values } = parseArgs({ options: {
  arms: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, mirrors: { type: 'string' },
  codegraph: { type: 'string' }, 'laya-url': { type: 'string' }, jobs: { type: 'string' }, 'provider-jobs': { type: 'string' },
  'max-requests': { type: 'string' }, 'response-tokens': { type: 'string' }, top: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log([
    'npm run bench:compare -- --arms ripgrep,bm25,codegraph-query,codegraph-context,laya [--codegraph <bin>] [--laya-url http://127.0.0.1:8765]',
    'npm run bench:compare -- --arms jevgrep --config <trusted-config> [--provider-jobs 1]',
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

type Answer = { readonly ranges: readonly Range[]; readonly complete: boolean; readonly returnedChars: number; readonly detail?: unknown };
type Tree = { readonly root: string; readonly files: Readonly<Record<string, string>>; readonly indexMs: Partial<Record<Arm, number>> };

/** Identifier-ish terms, including split camelCase/snake_case parts. */
function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    out.push(word.toLowerCase());
    for (const part of word.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) if (part.length > 1 && part !== word) out.push(part.toLowerCase());
  }
  return out;
}

const stop = new Set(('the a an and or of to in is it be for on with as by this that at from are was were not but if then else when which what where who how why can could would should will do does did has have had its into than there their them they we you your our i me my he she his her so no yes all any some such only also more most other just one two use used using code existing must change resolve issue does this here these those been being get set').split(' '));

/** Non-overlapping line windows per file, so a hit covers a function-sized region. */
function windows(files: Readonly<Record<string, string>>, size = 40, stride = 20) {
  const out: { path: string; start: number; end: number; tokens: string[] }[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/\.(py|pyi|js|ts|java|rst|txt|cfg|toml)$/.test(path)) continue;
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
  const args = ['-n', '--no-heading', '-i', '-w', '-F', ...named.flatMap((term) => ['-e', term]), '.'];
  const { stdout } = await run('rg', args, { cwd: tree.root, maxBuffer: 1 << 28 }).catch((cause: { stdout?: string }) => ({ stdout: cause.stdout ?? '' }));
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

const manifest = loadManifest();
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
if (selected.some((arm) => arm.startsWith('codegraph'))) {
  await mapLimit(tasks, jobs, async (task) => {
    const tree = trees.get(task.id)!;
    const started = performance.now();
    await run(codegraphBin, ['init', '.'], { cwd: tree.root, maxBuffer: 1 << 26, env: { ...process.env, DO_NOT_TRACK: '1' } });
    tree.indexMs['codegraph-query'] = tree.indexMs['codegraph-context'] = performance.now() - started;
  });
}

const live = selected.includes('jevgrep')
  ? liveProvider(values.config ?? (() => { throw new Error('--config is required for the jevgrep arm'); })(), {
    requests: positiveInteger(values['max-requests'], 400), estimatedInputTokens: 4_000_000,
  })
  : null;
const laya = new JevAdapter({ model: 'english', baseUrl: layaUrl, apiKey: 'local' });
const layaConfigure = (base: Configuration): Configuration => ({
  ...base, remote_evaluation_enabled: true,
  search: { ...base.search, concurrency: 2, deadline_ms: 900_000 }, cache: { ...base.cache, enabled: false },
});

const queries = tasks.flatMap((task) => task.queries.map((query) => ({ task, query })));
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
      : await engineSearch(tree, query, live!.provider, (b) => live!.configure(b));
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
  arm === 'jevgrep' ? positiveInteger(values['provider-jobs'], 1) : arm === 'laya' ? 3 : jobs,
  ({ task, query }) => answer(arm, task, query))));
const rows = perArm.flat();

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
  };
}

const summary = Object.fromEntries(selected.map((arm) => {
  const group = rows.filter((row) => row.arm === arm);
  const indexes = [...trees.values()].flatMap((tree) => tree.indexMs[arm] === undefined ? [] : [tree.indexMs[arm]!]);
  return [arm, {
    overall: summarize(group), indexMs: latencySummary(indexes),
    byCategory: Object.fromEntries([...groupBy(group, (row) => row.category)].map(([key, g]) => [key, summarize(g)])),
    byRepository: Object.fromEntries([...groupBy(group, (row) => row.repository)].map(([key, g]) => [key, summarize(g)])),
  }];
}));

const report = {
  schemaVersion: 1, kind: 'retriever-comparison', createdAt: new Date().toISOString(), environment: environment(),
  dataset: { version: manifest.version, source: manifest.source, tasks: tasks.length, queries: queries.length },
  settings: { arms: selected, top, responseTokens, codegraph: codegraphBin, layaUrl, jevgrep: live?.settings ?? null },
  semantics: {
    ranking: 'each arm returns ranked line ranges; the same localization metrics score every arm',
    recallAt5OverPlanned: 'incomplete or failed queries count as zero',
    returned: 'context size delivered to the caller: lines in the top 5 ranges and characters of all returned ranges',
    labels: 'patch sites and quoted-docstring functions; not exhaustive relevance',
  },
  usage: live?.usage ?? null, summary, rows,
};
const path = writeReport(values.output ?? 'benchmark-results/compare.json', report);
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([arm, s]) => [arm, { ...s.overall, indexMs: s.indexMs.median }])), null, 1));
console.log(`Report: ${path}`);
