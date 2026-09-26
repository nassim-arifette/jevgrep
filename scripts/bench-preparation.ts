/**
 * Preparation-cache benchmark: uncached preparation versus the content-verified cache.
 *
 * Each step of a corpus sequence runs in a fresh process, as a CLI invocation would,
 * so a "warm" step reads only the persisted cache. Both arms prepare the same tree and
 * every step checks that their observable outputs (fragments, exact text, offsets,
 * token counts, exclusions) are byte-identical. Independent sequences run in parallel.
 *
 *   node scripts/bench-preparation.ts --corpus flask=/path/to/flask --repeats 3 --jobs 4 \
 *     --output benchmark-results/preparation-cache.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { SearchProfiler } from '../src/profiling.ts';
import { AuthorizedRoot } from '../src/source/authorization.ts';
import { DEFAULT_WINDOW_LIMITS } from '../src/source/chunker.ts';
import { PreparationCache } from '../src/source/preparation-cache.ts';
import { prepareScope } from '../src/source/prepare.ts';
import type { PreparedScope } from '../src/source/prepare.ts';

const script = fileURLToPath(import.meta.url);
const steps = ['cold', 'warm', 'modify', 'add', 'delete', 'deny_change', 'limits_change', 'corrupt'] as const;
type Step = typeof steps[number];
type Arm = 'uncached' | 'cached';
type StepInput = { root: string; cacheDir: string; arm: Arm; step: Step };

const STAGES = ['source_read', 'hash', 'decode', 'secret_scan', 'chunking', 'parsing', 'tokenization', 'cache_lookup', 'cache_write'] as const;

function digest(prepared: PreparedScope): string {
  const hash = createHash('sha256');
  for (const fragment of prepared.fragments) {
    hash.update(JSON.stringify([fragment.id, fragment.sha256, fragment.startLine, fragment.endLine, fragment.byteStart,
      fragment.byteEnd, fragment.byteCount, fragment.tokenCount, fragment.chunker, fragment.classification,
      fragment.label ?? null, fragment.text]));
  }
  hash.update(JSON.stringify([prepared.excluded, prepared.complete, prepared.preparedBytes, prepared.parseFallbacks]));
  return hash.digest('hex');
}

function directoryBytes(path: string): { bytes: number; entries: number } {
  let bytes = 0; let entries = 0;
  let shards: string[];
  try { shards = readdirSync(path).filter((name) => /^[a-f0-9]{2}$/.test(name)); } catch { return { bytes, entries }; }
  for (const shard of shards) {
    for (const name of readdirSync(join(path, shard))) { bytes += statSync(join(path, shard, name)).size; entries += 1; }
  }
  return { bytes, entries };
}

async function runStep(input: StepInput) {
  const limits = input.step === 'limits_change' ? { ...DEFAULT_WINDOW_LIMITS, targetLines: 40, maxLines: 60 } : DEFAULT_WINDOW_LIMITS;
  const deny = input.step === 'deny_change' ? ['**/test*/**', '**/*_test.*', '**/*Test.java'] : [];
  const cache = input.arm === 'cached' ? new PreparationCache({ directory: input.cacheDir, enabled: true, maxBytes: 1_073_741_824 }) : undefined;
  const profiler = new SearchProfiler();
  let prepared: PreparedScope | undefined;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  await profiler.run(async () => {
    prepared = prepareScope(AuthorizedRoot.open(input.root), ['.'], {
      inventory: { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: deny },
      windowLimits: limits, ...(cache === undefined ? {} : { cache }),
    });
  });
  const wallMs = performance.now() - start;
  const profile = profiler.snapshot();
  return {
    ...input, wallMs, digest: digest(prepared!),
    files: prepared!.files.length, fragments: prepared!.fragments.length, excluded: prepared!.excluded.length,
    stages: Object.fromEntries(STAGES.map((stage) => [stage, profile.stages[stage] ?? { calls: 0, durationMs: 0 }])) as
      Record<typeof STAGES[number], { calls: number; durationMs: number }>,
    counters: profile.counters, cacheStats: cache?.stats ?? null,
    storage: input.arm === 'cached' ? directoryBytes(input.cacheDir) : null,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

function child(input: StepInput): Promise<Awaited<ReturnType<typeof runStep>>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, '--step', JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    proc.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as Awaited<ReturnType<typeof runStep>>) : reject(new Error(`step ${input.step} exited ${String(code)}`))));
  });
}

function sourceFiles(root: string): string[] {
  return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n')
    .filter((path) => /\.(py|java|ts|js|md)$/.test(path));
}

/** Apply the edit that precedes a step; identical for both arms. */
function mutate(root: string, step: Step, files: readonly string[], cacheDir: string): void {
  const pick = files[Math.floor(files.length / 2)]!;
  if (step === 'modify') writeFileSync(join(root, pick), `${readFileSync(join(root, pick), 'utf8')}\n// edited by benchmark\n`);
  if (step === 'add') { mkdirSync(join(root, 'bench_added'), { recursive: true }); writeFileSync(join(root, 'bench_added', 'added.py'), 'def added(x):\n    return x + 1\n'); }
  if (step === 'delete') rmSync(join(root, files[Math.floor(files.length / 3)]!));
  if (step === 'corrupt') {
    let index = 0;
    for (const shard of readdirSync(cacheDir).filter((name) => /^[a-f0-9]{2}$/.test(name))) {
      for (const name of readdirSync(join(cacheDir, shard))) {
        if (index++ % 10 === 0) writeFileSync(join(cacheDir, shard, name), '{"schema_version":1,"trunc');
      }
    }
  }
}

async function sequence(name: string, source: string, repeat: number) {
  const work = mkdtempSync(join(tmpdir(), `jev-prep-${name}-`));
  const rows = [];
  try {
    const trees = { uncached: join(work, 'uncached', 'repo'), cached: join(work, 'cached', 'repo') };
    for (const tree of Object.values(trees)) {
      mkdirSync(dirname(tree), { recursive: true });
      cpSync(source, tree, { recursive: true, filter: (path) => !path.endsWith('/.git') });
    }
    const files = sourceFiles(source);
    const cacheDir = join(work, 'prep-cache');
    for (const step of steps) {
      const results: Record<Arm, Awaited<ReturnType<typeof runStep>>> = {} as never;
      for (const arm of ['uncached', 'cached'] as const) {
        if (step !== 'corrupt' || arm === 'cached') mutate(trees[arm], step, files, cacheDir);
        results[arm] = await child({ root: trees[arm], cacheDir, arm, step });
      }
      rows.push({ corpus: name, repeat, step, equal: results.uncached.digest === results.cached.digest, uncached: results.uncached, cached: results.cached });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return rows;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepIndex = args.indexOf('--step');
  if (stepIndex >= 0) { process.stdout.write(JSON.stringify(await runStep(JSON.parse(args[stepIndex + 1]!) as StepInput))); return; }
  const corpora: [string, string][] = [];
  let repeats = 3; let jobs = 4; let output = 'benchmark-results/preparation-cache.json';
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--corpus') { const [n, p] = args[i + 1]!.split('='); corpora.push([n!, p!]); }
    else if (args[i] === '--repeats') repeats = Number(args[i + 1]);
    else if (args[i] === '--jobs') jobs = Number(args[i + 1]);
    else if (args[i] === '--output') output = args[i + 1]!;
  }
  const plan = corpora.flatMap(([name, path]) => Array.from({ length: repeats }, (_, repeat) => ({ name, path, repeat })));
  const rows = (await mapLimit(plan, jobs, (item) => sequence(item.name, item.path, item.repeat))).flat();
  const summary = [];
  for (const [name] of corpora) {
    for (const step of steps) {
      const group = rows.filter((row) => row.corpus === name && row.step === step);
      const u = median(group.map((row) => row.uncached.wallMs));
      const c = median(group.map((row) => row.cached.wallMs));
      summary.push({
        corpus: name, step, samples: group.length, allEqual: group.every((row) => row.equal),
        files: group[0]!.cached.files, fragments: group[0]!.cached.fragments,
        uncachedMedianMs: Math.round(u), cachedMedianMs: Math.round(c), speedup: Number((u / c).toFixed(2)),
        tokenizationCalls: { uncached: group[0]!.uncached.stages.tokenization.calls, cached: group[0]!.cached.stages.tokenization.calls },
        chunkingCalls: { uncached: group[0]!.uncached.stages.chunking.calls, cached: group[0]!.cached.stages.chunking.calls },
        cacheStats: group[0]!.cached.cacheStats, storageBytes: group[0]!.cached.storage?.bytes ?? null,
        peakRssMiB: { uncached: Math.round(median(group.map((r) => r.uncached.peakRssBytes)) / 1048576), cached: Math.round(median(group.map((r) => r.cached.peakRssBytes)) / 1048576) },
      });
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), repeats, jobs, summary, rows }, null, 2)}\n`);
  console.table(summary.map(({ corpus, step, allEqual, files, uncachedMedianMs, cachedMedianMs, speedup, tokenizationCalls, chunkingCalls }) => ({
    corpus, step, allEqual, files, uncachedMs: uncachedMedianMs, cachedMs: cachedMedianMs, speedup,
    tok: `${String(tokenizationCalls.uncached)}->${String(tokenizationCalls.cached)}`, chunk: `${String(chunkingCalls.uncached)}->${String(chunkingCalls.cached)}`,
  })));
}

await main();
