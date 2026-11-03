/**
 * Cancellation latency during local preparation (roadmap section 5).
 *
 * A timer requests a stop after `--after-ms` of preparation, as an MCP
 * `notifications/cancelled` would. The latency is the time from the moment the stop
 * was due until preparation returned. Synchronous preparation cannot see the timer
 * until it ends; cooperative preparation yields between files.
 *
 *   node scripts/bench-cancellation.ts --root /path/to/repo [--after-ms 200] [--repeats 3]
 */
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { AuthorizedRoot } from '../src/source/authorization.ts';
import { prepareScope, prepareScopeCooperatively } from '../src/source/prepare.ts';

const { values } = parseArgs({
  options: { root: { type: 'string' }, 'after-ms': { type: 'string', default: '200' }, repeats: { type: 'string', default: '3' } },
});
if (values.root === undefined) {
  process.stderr.write('usage: node scripts/bench-cancellation.ts --root <repository> [--after-ms 200] [--repeats 3]\n');
  process.exit(2);
}
const root = values.root;
const afterMs = Number(values['after-ms']);
const repeats = Number(values.repeats);
const inventory = { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: [] };

type Arm = 'synchronous' | 'cooperative';

async function measure(arm: Arm): Promise<{ latencyMs: number; complete: boolean; files: number }> {
  let stop = false;
  const start = performance.now();
  const timer = setTimeout(() => {
    stop = true;
  }, afterMs);
  const shouldStop = (): boolean => stop;
  const options = { inventory: { ...inventory, shouldStop }, shouldStop };
  const prepared = arm === 'synchronous'
    ? await Promise.resolve().then(() => prepareScope(AuthorizedRoot.open(root), ['.'], options))
    : await prepareScopeCooperatively(AuthorizedRoot.open(root), ['.'], options);
  const end = performance.now();
  clearTimeout(timer);
  return { latencyMs: Math.max(0, end - start - afterMs), complete: prepared.complete, files: prepared.files.length };
}

const full = performance.now();
const total = prepareScope(AuthorizedRoot.open(root), ['.'], { inventory });
const fullMs = performance.now() - full;
const rows: Record<string, unknown>[] = [];
for (const arm of ['synchronous', 'cooperative'] as const) {
  const runs = [];
  for (let n = 0; n < repeats; n += 1) runs.push(await measure(arm));
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);
  rows.push({
    arm, stop_after_ms: afterMs, median_latency_ms: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
    max_latency_ms: Math.round(latencies.at(-1) ?? 0), stopped_early: runs.every((run) => !run.complete),
  });
}
process.stdout.write(`${JSON.stringify({
  root, eligible_files: total.files.length, full_preparation_ms: Math.round(fullMs), arms: rows,
}, null, 2)}\n`);
