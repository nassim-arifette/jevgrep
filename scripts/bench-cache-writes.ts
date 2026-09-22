/** Paired local comparison of 64 independent writes and one grouped write. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { ScoreCache } from '../src/evaluation/cache.ts';
import type { ScoreCacheWrite } from '../src/evaluation/cache.ts';

const { values } = parseArgs({ options: { pairs: { type: 'string' } } });
const pairs = values.pairs === undefined ? 5 : Number(values.pairs);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 30) throw new Error('--pairs must be an integer from 1 to 30');

const meta = { modelRevision: 'jev-1.13.0', layout: 'layout-a-1', criterion: 'criterion-1', chunker: 'chunker-1' };
const writes: ScoreCacheWrite[] = Array.from({ length: 64 }, (_, index) => ({
  identity: createHash('sha256').update(`cache-write-pair-${index}`).digest('hex'),
  score: (index + 1) / 65,
  meta,
}));

function measure(mode: 'individual' | 'grouped'): number {
  const directory = mkdtempSync(join(tmpdir(), 'jevgrep-cache-paired-'));
  try {
    const cache = new ScoreCache({ directory, enabled: true, ttlSeconds: 604_800, maxBytes: 100_000_000 });
    const start = performance.now();
    if (mode === 'grouped') {
      if (cache.writeMany(writes) !== writes.length) throw new Error('incomplete grouped write');
    } else {
      for (const { identity, score, meta: entryMeta } of writes) {
        if (!cache.write(identity, score, entryMeta)) throw new Error('incomplete individual write');
      }
    }
    const elapsedMs = performance.now() - start;
    for (const { identity, score } of writes) {
      if (cache.read(identity) !== score) throw new Error('score read-back mismatch');
    }
    return elapsedMs;
  } finally {
    const target = resolve(directory);
    const parent = resolve(tmpdir());
    if (relative(parent, target).startsWith(`..${sep}`) || !basename(target).startsWith('jevgrep-cache-paired-')) {
      throw new Error('unsafe benchmark cleanup target');
    }
    rmSync(target, { recursive: true, force: true });
  }
}

// Warm both paths before measuring and alternate order within successive pairs.
measure('individual');
measure('grouped');
const samples: { individualMs: number; groupedMs: number; ratio: number }[] = [];
for (let index = 0; index < pairs; index += 1) {
  const order: ('individual' | 'grouped')[] = index % 2 === 0
    ? ['individual', 'grouped'] : ['grouped', 'individual'];
  const times = { individual: 0, grouped: 0 };
  for (const mode of order) times[mode] = measure(mode);
  samples.push({ individualMs: times.individual, groupedMs: times.grouped,
    ratio: times.individual / times.grouped });
  console.error(`Pair ${index + 1}/${pairs}: individual ${times.individual.toFixed(0)} ms; grouped ${times.grouped.toFixed(0)} ms`);
}
function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
console.log(JSON.stringify({
  kind: 'paired-cache-write', pairs, entries: writes.length,
  medianIndividualMs: median(samples.map((item) => item.individualMs)),
  medianGroupedMs: median(samples.map((item) => item.groupedMs)),
  medianPairedRatio: median(samples.map((item) => item.ratio)),
  samples,
}, null, 2));
