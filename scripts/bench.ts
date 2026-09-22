import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { environment, positiveInteger, projectRoot, writeReport } from './bench/common.ts';
import { distribution, runLocalSample, scenarios } from './bench/local.ts';

const { values } = parseArgs({ options: {
  files: { type: 'string' }, samples: { type: 'string' }, output: { type: 'string' },
  child: { type: 'boolean' }, 'no-profile': { type: 'boolean' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('npm run bench -- [--files 64] [--samples 3] [--output benchmark-results/local.json] [--no-profile]');
} else {
  const files = positiveInteger(values.files, 64);
  const sampleCount = positiveInteger(values.samples, 3);
  if (values.child) {
    console.log(JSON.stringify(await runLocalSample(files, !values['no-profile'])));
  } else {
    const host = environment();
    const samples: Awaited<ReturnType<typeof runLocalSample>>[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      console.error(`Local benchmark sample ${sample + 1}/${sampleCount}, ${files} files`);
      const child = spawnSync(process.execPath, [
        '--import', new URL('../tests/helpers/offline-preload.ts', import.meta.url).href,
        fileURLToPath(import.meta.url), '--child', '--files', String(files),
        ...(values['no-profile'] ? ['--no-profile'] : []),
      ], { cwd: projectRoot, encoding: 'utf8', timeout: 1_300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      if (child.error !== undefined || child.status !== 0) throw new Error(child.stderr || child.error?.message || 'benchmark child failed');
      samples.push(JSON.parse(child.stdout) as Awaited<ReturnType<typeof runLocalSample>>);
    }
    const summary = scenarios.map((scenario, index) => ({
      scenario,
      elapsedMs: distribution(samples.map((sample) => sample.rows[index]!.elapsedMs)),
      initialTimerDelayMs: distribution(samples.map((sample) => sample.rows[index]!.initialTimerDelayMs)),
      providerAttempts: distribution(samples.map((sample) => sample.rows[index]!.report.usage.provider_request_attempts)),
      cacheReused: distribution(samples.map((sample) => sample.rows[index]!.report.fragments.cache_reused)),
      transmittedBytes: distribution(samples.map((sample) => sample.rows[index]!.report.usage.transmitted_bytes)),
    }));
    const report = {
      schemaVersion: 1, kind: 'local-performance', createdAt: new Date().toISOString(), environment: host,
      settings: { files, samples: sampleCount, instrumented: !values['no-profile'], responseTokens: 4_000, concurrency: 1 },
      semantics: {
        provider: 'offline fixed scores; reported usage is a synthetic reference-token count; no billed requests',
        quality: 'not measured; use bench:retrieval for real provider judgments',
        cache: 'new score cache and fresh process per sample; four ordered searches share one engine; no preparation cache exists',
        cold: 'cold process/tokenizer/score cache; OS filesystem cache is uncontrolled; startup/imports and fixture setup excluded',
        timings: 'inclusive stages overlap; provider includes adapter work and waiting, not isolated network time',
        memory: 'sampled maxima at instrumented boundaries; process peak RSS covers the whole child including setup',
      },
      summary, samples,
    };
    const current = environment();
    if (current.sourceHash !== host.sourceHash || current.harnessHash !== host.harnessHash || current.packageLockHash !== host.packageLockHash) {
      throw new Error('source, harness or dependencies changed during measurement; rerun on a stable checkout');
    }
    const path = writeReport(values.output ?? 'benchmark-results/local.json', report);
    console.table(summary.map((row) => ({
      scenario: row.scenario, medianMs: Math.round(row.elapsedMs.median),
      attempts: row.providerAttempts.median, reused: row.cacheReused.median,
      transmittedBytes: row.transmittedBytes.median,
    })));
    console.log(`Report: ${path}`);
  }
}
