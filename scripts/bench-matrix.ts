/** Offline fixed-workload matrix; each sample runs in a fresh, network-blocked process. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { environment, positiveInteger, projectRoot, writeReport } from './bench/common.ts';
import { runMatrixSample, summarizeMatrix } from './bench/matrix.ts';

const { values } = parseArgs({ options: {
  files: { type: 'string' }, samples: { type: 'string' }, output: { type: 'string' }, child: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('npm run bench:matrix -- [--files 64] [--samples 3] [--output benchmark-results/matrix.json]');
} else {
  const files = positiveInteger(values.files, 64);
  const count = positiveInteger(values.samples, 3);
  if (values.child) {
    console.log(JSON.stringify(await runMatrixSample(files)));
  } else {
    const host = environment();
    const samples: Awaited<ReturnType<typeof runMatrixSample>>[] = [];
    for (let index = 0; index < count; index += 1) {
      console.error(`Offline matrix sample ${String(index + 1)}/${String(count)}`);
      const child = spawnSync(process.execPath, ['--import', new URL('../tests/helpers/offline-preload.ts', import.meta.url).href,
        fileURLToPath(import.meta.url), '--child', '--files', String(files)],
      { cwd: projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      if (child.error !== undefined || child.status !== 0) throw new Error(child.stderr || child.error?.message || 'matrix child failed');
      samples.push(JSON.parse(child.stdout) as Awaited<ReturnType<typeof runMatrixSample>>);
    }
    const current = environment();
    if (current.sourceHash !== host.sourceHash || current.harnessHash !== host.harnessHash || current.packageLockHash !== host.packageLockHash) {
      throw new Error('source, harness or dependencies changed during measurement; rerun on a stable checkout');
    }
    const summary = summarizeMatrix(samples);
    const path = writeReport(values.output ?? 'benchmark-results/matrix.json', {
      schemaVersion: 1, kind: 'offline-performance-matrix', createdAt: new Date().toISOString(), environment: host,
      settings: { files, samples: count, responseTokens: 4_000, concurrency: 1 },
      semantics: {
        provider: 'offline fixed scores and reference-token usage; no paid requests or model-quality conclusions',
        cold: 'fresh process, tokenizer and owned caches per sample; startup/fixture setup excluded; OS cache uncontrolled',
        warm: 'ordered searches share one engine; edits and movement apply to the frozen synthetic workload',
        continuation: '70 single-fragment files; first attempt scores 64, measured continuation scores the remaining six',
        interruptions: 'manual deadlines injected in preparation, planning, evaluation and selection; wall timings measure recovery work, not ten-millisecond SLA accuracy',
        cancellation: 'real setImmediate cancellation requested during first warm score lookup; delivery and return delays are separate',
        ping: 'real stdio MCP ping scheduled during first warm score lookup; latency includes event-loop scheduling and JSON transport',
        memory: 'sampled RSS at instrumented boundaries, not guaranteed process peak; inclusive stage durations overlap',
        percentiles: 'p50 is the median; p95 omitted below 20 samples; no uncertainty or live-provider latency claims',
      }, summary, samples,
    });
    console.table(summary.map((row) => ({ scenario: row.scenario, p50Ms: row.latencyMs.median,
      p95Ms: row.latencyMs.p95, completion: row.completionRate, attempts: row.meanProviderAttempts, diskReads: row.meanScoreDiskReads })));
    console.log(`Report: ${path}`);
  }
}
