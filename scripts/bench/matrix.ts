/** Reproducible offline plumbing matrix. Fixed scores measure execution, not retrieval quality. */
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { createSearchEngine, type EngineOptions, type SearchEngine, type SearchOutcomeWithDiagnostics } from '../../src/engine.ts';
import type { SearchResult } from '../../src/contracts.ts';
import type { ProviderClient } from '../../src/evaluation/contracts.ts';
import { buildRequestPayload } from '../../src/evaluation/jev.ts';
import { runMcpServer, TOOL_NAME } from '../../src/mcp.ts';
import { SearchProfiler } from '../../src/profiling.ts';
import { countReferenceTokens } from '../../src/response/token-counter.ts';
import { DEFAULT_CHUNKER } from '../../src/source/chunker.ts';
import { ManualClock } from '../../src/testing/manual-clock.ts';
import { treeHash, workspace } from './common.ts';
import { workload } from './local.ts';
import { latencySummary, mean } from './report.ts';

export const matrixScenarios = [
  'cold', 'identical_query', 'new_query', 'edited_file', 'shifted_function', 'continuation', 'multiquestion',
  'deadline_preparation', 'deadline_planning', 'deadline_evaluation', 'deadline_selection', 'cancellation', 'mcp_ping',
] as const;
export type MatrixScenario = typeof matrixScenarios[number];

type CacheReads = { disk_reads?: number; memory_hits?: number };
export type MatrixRow = {
  scenario: MatrixScenario;
  elapsedMs: number;
  initialTimerDelayMs: number;
  cancellationDeliveryMs: number | null;
  cancellationReturnMs: number | null;
  mcpPingLatencyMs: number | null;
  responseTokens: number;
  scoreDiskReads: number | null;
  scoreMemoryHits: number | null;
  providerAttempts: number;
  representedFragments: number;
  cacheReused: number;
  remoteEvaluated: number;
  complete: number;
  questions: number;
  statuses: string[];
  stopReasons: string[];
  profile: ReturnType<SearchProfiler['snapshot']>;
};

function offlineProvider(): ProviderClient {
  const model = 'jev-1.13.0';
  return { model,
    serializeBatch: (batch) => JSON.stringify(buildRequestPayload(batch, model)),
    async evaluateBatch(batch) {
      const payload = JSON.stringify(buildRequestPayload(batch, model));
      return { scores: new Map(batch.items.map((item) => [item.id, 0.8])), invalid: [],
        usage: { inputTokens: countReferenceTokens(payload), outputTokens: 0 }, requestedModel: model, returnedModel: model,
        transmittedBytes: Buffer.byteLength(payload), requestId: null };
    },
  };
}

const movingFunction = (name: string): string => `export function ${name}(input) {\n${Array.from({ length: 65 }, (_, index) =>
  `  const v${String(index)} = input.${name}${String(index)} ?? compute${String(index)}(input);`).join('\n')}\n  return v0;\n}\n`;
const QUERY = 'Where are retention cutoffs calculated?';

function result(outcome: SearchOutcomeWithDiagnostics): SearchResult {
  if (!('report' in outcome.outcome)) throw new Error(`matrix expected a coverage report, received ${JSON.stringify(outcome.outcome)}`);
  return outcome.outcome;
}

async function measure(
  scenario: MatrixScenario, engine: SearchEngine,
  work: (profile: SearchProfiler) => Promise<readonly SearchOutcomeWithDiagnostics[]>,
  extra: () => Pick<MatrixRow, 'cancellationDeliveryMs' | 'cancellationReturnMs' | 'mcpPingLatencyMs'> = () =>
    ({ cancellationDeliveryMs: null, cancellationReturnMs: null, mcpPingLatencyMs: null }),
): Promise<MatrixRow> {
  const profile = new SearchProfiler();
  const before = { ...engine.cache.stats } as CacheReads;
  const start = performance.now();
  const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
  const outcomes = await work(profile);
  const elapsedMs = performance.now() - start;
  const initialTimerDelayMs = await timer;
  const after = engine.cache.stats as CacheReads;
  const reports = outcomes.flatMap((entry) => 'report' in entry.outcome ? [entry.outcome.report] : []);
  return {
    scenario, elapsedMs, initialTimerDelayMs, ...extra(),
    responseTokens: outcomes.reduce((sum, entry) => sum + (entry.measuredTokens ?? countReferenceTokens(JSON.stringify(entry.outcome))), 0),
    scoreDiskReads: before.disk_reads === undefined || after.disk_reads === undefined ? null : after.disk_reads - before.disk_reads,
    scoreMemoryHits: before.memory_hits === undefined || after.memory_hits === undefined ? null : after.memory_hits - before.memory_hits,
    providerAttempts: reports.reduce((sum, report) => sum + report.usage.provider_request_attempts, 0),
    representedFragments: reports.reduce((sum, report) => sum + report.fragments.represented_in_response, 0),
    cacheReused: reports.reduce((sum, report) => sum + report.fragments.cache_reused, 0),
    remoteEvaluated: reports.reduce((sum, report) => sum + report.fragments.remote_evaluated, 0),
    complete: outcomes.filter((entry) => entry.outcome.status === 'complete').length,
    questions: outcomes.length, statuses: outcomes.map((entry) => entry.outcome.status),
    stopReasons: [...new Set(reports.flatMap((report) => report.stop_reasons))], profile: profile.snapshot(),
  };
}

async function interrupted(phase: 'preparation' | 'planning' | 'evaluation' | 'selection', files: Readonly<Record<string, string>>): Promise<MatrixRow> {
  const space = workspace(files, (base) => ({ ...base, search: { ...base.search, deadline_ms: 10, concurrency: 1 } }));
  try {
    const clock = new ManualClock();
    const provider = offlineProvider();
    const options: EngineOptions = { configuration: space.loaded, provider, clock,
      ...(phase === 'preparation' ? { chunker: {
        identity: DEFAULT_CHUNKER.identity,
        chunk: (snapshot, limits) => { clock.advanceBy(11); return DEFAULT_CHUNKER.chunk(snapshot, limits); },
      } } : {}),
    };
    if (phase === 'planning') provider.serializeBatch = (batch) => {
      clock.advanceBy(11);
      return JSON.stringify(buildRequestPayload(batch, provider.model));
    };
    if (phase === 'evaluation') {
      const evaluate = provider.evaluateBatch.bind(provider);
      provider.evaluateBatch = async (...args) => { const answer = await evaluate(...args); clock.advanceBy(11); return answer; };
    }
    const engine = createSearchEngine(options);
    const row = await measure(`deadline_${phase}`, engine, async (profile) => [await engine.search(
      { query: QUERY, max_context_tokens: 4_000 }, { profile, onProgress: (progress) => {
        if (phase === 'selection' && progress.phase === 'selection') clock.advanceBy(11);
      } },
    )]);
    if (!row.stopReasons.includes('DEADLINE') || row.statuses.some((status) => status !== 'partial')) {
      throw new Error(`deadline_${phase} did not return explicit partial coverage`);
    }
    return row;
  } finally { space.cleanup(); }
}

/** A real stdio MCP ping requested during the first score-cache read of a warm scan. */
async function pingRow(files: Readonly<Record<string, string>>): Promise<MatrixRow> {
  const space = workspace(files);
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider: offlineProvider() });
    await engine.search({ query: QUERY });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const read = engine.cache.read.bind(engine.cache);
    let scheduled = false;
    let requestedAt = 0;
    let pingLatency: number | null = null;
    engine.cache.read = (identity) => {
      if (!scheduled) {
        scheduled = true;
        requestedAt = performance.now();
        setImmediate(() => input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`));
      }
      return read(identity);
    };
    return await measure('mcp_ping', engine, async (profile) => {
      const search = engine.search.bind(engine);
      engine.search = (request, invocation) => search(request, { ...invocation, profile });
      let buffer = '';
      let answer: SearchOutcomeWithDiagnostics | undefined;
      const received = new Promise<void>((resolve) => {
        output.setEncoding('utf8');
        output.on('data', (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; result?: { structuredContent?: SearchResult } };
            buffer = buffer.slice(newline + 1);
            if (message.id === 2) pingLatency = performance.now() - requestedAt;
            if (message.id === 1 && message.result?.structuredContent !== undefined) {
              const outcome = message.result.structuredContent;
              answer = { outcome, searchId: outcome.search_id, measuredTokens: countReferenceTokens(JSON.stringify(outcome)) };
            }
            if (answer !== undefined && pingLatency !== null) { input.end(); resolve(); }
          }
        });
      });
      const serving = runMcpServer({ engine, input, output, errorOutput, serverVersion: 'offline-matrix' });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: { query: QUERY } } })}\n`);
      await received;
      await serving;
      if (answer === undefined) throw new Error('MCP matrix search produced no result');
      return [answer];
    }, () => ({ cancellationDeliveryMs: null, cancellationReturnMs: null, mcpPingLatencyMs: pingLatency }));
  } finally { space.cleanup(); }
}

async function cancellationRow(files: Readonly<Record<string, string>>): Promise<MatrixRow> {
  const space = workspace(files);
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider: offlineProvider() });
    await engine.search({ query: QUERY });
    const controller = new AbortController();
    const read = engine.cache.read.bind(engine.cache);
    let requestedAt = 0;
    let deliveredAt = 0;
    engine.cache.read = (identity) => {
      if (requestedAt === 0) {
        requestedAt = performance.now();
        setImmediate(() => { deliveredAt = performance.now(); controller.abort(); });
      }
      return read(identity);
    };
    let returnedAt = 0;
    return await measure('cancellation', engine, async (profile) => {
      const answer = await engine.search({ query: QUERY }, { profile, signal: controller.signal });
      returnedAt = performance.now();
      if (!('error' in answer.outcome) || answer.outcome.error.code !== 'CANCELLED') throw new Error('matrix cancellation was not observed');
      return [answer];
    }, () => ({ cancellationDeliveryMs: deliveredAt - requestedAt, cancellationReturnMs: returnedAt - deliveredAt, mcpPingLatencyMs: null }));
  } finally { space.cleanup(); }
}

/** Each fresh sample owns its fixtures and caches; setup and seeding are outside measured rows. */
export async function runMatrixSample(fileCount = 64): Promise<{ workloadHash: string; rows: MatrixRow[] }> {
  const files: Record<string, string> = { ...workload(fileCount), 'src/moved.ts': `${movingFunction('alpha')}\n${movingFunction('beta')}` };
  const space = workspace(files, (base) => ({ ...base, search: { ...base.search, deadline_ms: 300_000, concurrency: 1 } }));
  const rows: MatrixRow[] = [];
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider: offlineProvider() });
    const search = (scenario: MatrixScenario, query = QUERY) => measure(scenario, engine, async (profile) =>
      [await engine.search({ query, max_context_tokens: 4_000 }, { profile })]);
    rows.push(await search('cold'), await search('identical_query'), await search('new_query', 'How are expired records identified?'));
    space.write('src/module-00000.ts', files['src/module-00000.ts']!.replace('const retention = 30;', 'const retention = 31;'));
    rows.push(await search('edited_file'));
    space.write('src/moved.ts', `${movingFunction('added')}\n${files['src/moved.ts']}`);
    rows.push(await measure('shifted_function', engine, async (profile) => [await engine.search(
      { query: QUERY, scope: ['src/moved.ts'], max_context_tokens: 4_000 }, { profile },
    )]));
    rows.push(await measure('multiquestion', engine, (profile) => engine.searchMany([
      { query: QUERY, max_context_tokens: 4_000 }, { query: 'Which records have expired?', max_context_tokens: 4_000 },
    ], { profile })));
  } finally { space.cleanup(); }

  const continuationFiles = Object.fromEntries(Array.from({ length: 70 }, (_, index) =>
    [`src/${String(index).padStart(3, '0')}.ts`, `export const expiry${String(index)} = ${String(index)};\n`]));
  const continued = workspace(continuationFiles, (base) => ({ ...base, scan_caps: { ...base.scan_caps, request_attempts: 1 } }));
  try {
    const engine = createSearchEngine({ configuration: continued.loaded, provider: offlineProvider() });
    const first = result(await engine.search({ query: QUERY, max_context_tokens: 2_000, allow_partial_scan: true }));
    const token = first.continuation?.next;
    if (token == null) throw new Error('matrix continuation setup produced no continuation');
    rows.push(await measure('continuation', engine, async (profile) => {
      const next = await engine.search({ query: QUERY, max_context_tokens: 2_000, allow_partial_scan: true, continuation: token }, { profile });
      const response = result(next);
      if (response.report.fragments.cache_reused !== 64 || response.report.fragments.remote_evaluated !== 6) throw new Error('continuation repeated provider work');
      return [next];
    }));
  } finally { continued.cleanup(); }

  const interruptionFiles = workload(Math.min(fileCount, 8));
  for (const phase of ['preparation', 'planning', 'evaluation', 'selection'] as const) rows.push(await interrupted(phase, interruptionFiles));
  rows.push(await cancellationRow(workload(Math.max(40, fileCount))), await pingRow(workload(Math.max(40, fileCount))));
  return { workloadHash: treeHash(files), rows: matrixScenarios.map((scenario) => rows.find((row) => row.scenario === scenario)!) };
}

export function summarizeMatrix(samples: readonly Awaited<ReturnType<typeof runMatrixSample>>[]) {
  return matrixScenarios.map((scenario) => {
    const rows = samples.flatMap((sample) => sample.rows.filter((row) => row.scenario === scenario));
    const numeric = (key: 'cancellationDeliveryMs' | 'cancellationReturnMs' | 'mcpPingLatencyMs' | 'scoreDiskReads' | 'scoreMemoryHits') =>
      rows.flatMap((row) => row[key] === null ? [] : [row[key]!]);
    return {
      scenario, samples: rows.length, latencyMs: latencySummary(rows.map((row) => row.elapsedMs)),
      initialTimerDelayMs: latencySummary(rows.map((row) => row.initialTimerDelayMs)),
      cancellationDeliveryMs: latencySummary(numeric('cancellationDeliveryMs')), cancellationReturnMs: latencySummary(numeric('cancellationReturnMs')),
      mcpPingLatencyMs: latencySummary(numeric('mcpPingLatencyMs')),
      completionRate: rows.reduce((sum, row) => sum + row.complete, 0) / rows.reduce((sum, row) => sum + row.questions, 0),
      meanProviderAttempts: mean(rows.map((row) => row.providerAttempts)), meanRepresentedFragments: mean(rows.map((row) => row.representedFragments)),
      meanScoreDiskReads: mean(numeric('scoreDiskReads')), meanScoreMemoryHits: mean(numeric('scoreMemoryHits')),
      meanTokenizerInputUtf16: mean(rows.map((row) => row.profile.counters['tokenizerInputUtf16'] ?? 0)),
      sampledRssBytes: latencySummary(rows.map((row) => row.profile.memory.sampledMax.rssBytes)),
    };
  });
}
