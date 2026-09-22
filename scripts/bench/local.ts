import { createSearchEngine } from '../../src/engine.ts';
import { buildRequestPayload, type ProviderClient } from '../../src/evaluation/jev.ts';
import { SearchProfiler } from '../../src/profiling.ts';
import { countReferenceTokens } from '../../src/response/token-counter.ts';
import { performance } from 'node:perf_hooks';
import { treeHash, workspace } from './common.ts';

export const scenarios = ['cold', 'repeat_question', 'new_question', 'small_edit'] as const;

export function workload(fileCount: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < fileCount; index += 1) {
    const name = `module-${String(index).padStart(5, '0')}`;
    if (index % 4 === 1) {
      files[`src/${name}.py`] = Array.from({ length: 12 }, (_, n) =>
        `def expired_${n}(record, now):\n    cutoff = now - ${30 + n}\n    return record.created_at < cutoff\n`).join('\n');
    } else if (index % 4 === 2) {
      files[`data/${name}.sql`] = Array.from({ length: 12 }, (_, n) =>
        `CREATE TABLE event_${index}_${n} (\n  id INTEGER PRIMARY KEY,\n  created_at TEXT NOT NULL\n);`).join('\n');
    } else {
      files[`src/${name}.ts`] = Array.from({ length: 12 }, (_, n) =>
        `export function expire${n}(createdAt: number, now: number): boolean {\n  const retention = ${30 + n};\n  return createdAt + retention < now;\n}\n`).join('\n');
    }
  }
  return files;
}

/** Deterministic plumbing workload. Its scores are deliberately not retrieval judgments. */
function offlineProvider(): ProviderClient {
  const model = 'jev-1.13.0';
  return {
    model,
    serializeBatch: (batch) => JSON.stringify(buildRequestPayload(batch, model)),
    async evaluateBatch(batch) {
      const payload = JSON.stringify(buildRequestPayload(batch, model));
      return {
        scores: new Map(batch.items.map((item) => [item.id, 0.8])), invalid: [],
        usage: { inputTokens: countReferenceTokens(payload), outputTokens: 0 },
        requestedModel: model, returnedModel: model,
        transmittedBytes: Buffer.byteLength(payload), requestId: null,
      };
    },
  };
}

export async function runLocalSample(fileCount: number, instrumented = true) {
  const files = workload(fileCount);
  const space = workspace(files, (base) => ({
    ...base, search: { ...base.search, deadline_ms: 300_000, concurrency: 1 },
  }));
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider: offlineProvider() });
    const rows = [];
    for (const scenario of scenarios) {
      if (scenario === 'small_edit') {
        const path = 'src/module-00000.ts';
        space.write(path, files[path]!.replace('const retention = 30;', 'const retention = 31;'));
      }
      const profile = instrumented ? new SearchProfiler() : undefined;
      const start = performance.now();
      // The first timer observes synchronous work before the event loop can run it.
      // It is not a cancellation-latency or continuous event-loop-delay measurement.
      const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
      const result = await engine.search({
        query: scenario === 'new_question' ? 'How are expired records identified?' : 'Where are retention cutoffs calculated?',
        scope: ['.'], max_context_tokens: 4_000,
      }, { searchId: 'benchmark', ...(profile === undefined ? {} : { profile }) });
      const elapsedMs = performance.now() - start;
      const initialTimerDelayMs = await timer;
      if (!('report' in result.outcome) || !result.outcome.report.scope_fully_scanned || result.outcome.status !== 'complete') {
        throw new Error(`benchmark scenario ${scenario} did not complete`);
      }
      rows.push({
        scenario, elapsedMs, initialTimerDelayMs, profile: profile?.snapshot() ?? null,
        responseTokens: result.measuredTokens, report: result.outcome.report,
      });
    }
    const cold = rows[0]!.report.fragments;
    if (rows[1]!.report.usage.provider_request_attempts !== 0
      || rows[1]!.report.fragments.cache_reused !== cold.total
      || rows[2]!.report.fragments.cache_reused !== 0
      || rows[3]!.report.fragments.remote_evaluated < 1
      || (fileCount > 1 && rows[3]!.report.fragments.cache_reused === 0)) {
      throw new Error('benchmark did not exercise the intended cache states');
    }
    return { workloadHash: treeHash(files), fileCount, rows, processPeakRssBytes: process.resourceUsage().maxRSS * 1024 };
  } finally {
    space.cleanup();
  }
}

export function distribution(values: readonly number[]) {
  if (values.length === 0) throw new Error('cannot summarize an empty sample');
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    min: ordered[0]!, median: ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!,
    max: ordered[ordered.length - 1]!,
  };
}
