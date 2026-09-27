import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSearchEngine } from '../src/engine.ts';
import { analyzePairedRuns, mulberry32, scoreSubmission, type AgentRun, type Arm } from './bench/agent.ts';
import { chatCompletions, runAgent, systemPrompt, type JevSearch } from './bench/agent-loop.ts';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import { digest } from './bench/freeze.ts';
import { liveProvider } from './bench/live-provider.ts';
import { loadManifest, mapLimit } from './bench/real-tasks.ts';
import { loadSnapshots } from './bench/snapshots.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, output: { type: 'string' }, mirrors: { type: 'string' }, only: { type: 'string' },
  repeats: { type: 'string' }, jobs: { type: 'string' }, model: { type: 'string' }, 'agent-key-env': { type: 'string' },
  'agent-base-url': { type: 'string' }, 'max-turns': { type: 'string' }, seed: { type: 'string' },
  'max-requests': { type: 'string' }, 'max-input-tokens': { type: 'string' }, 'response-tokens': { type: 'string' }, help: { type: 'boolean' },
} });

/** Agent list prices per token; the gateway response carries no bill. Update with the model. */
const agentPrices: Readonly<Record<string, { input: number; output: number }>> = { 'openai/gpt-5-mini': { input: 0.25e-6, output: 2e-6 } };

if (values.help || values.config === undefined) {
  console.log('npm run bench:agent -- --config <trusted-jev-config> [--model openai/gpt-5-mini] [--agent-key-env AI_GATEWAY_API_KEY] [--repeats 2] [--jobs 4] [--only id,id] [--output benchmark-results/agent.json]');
} else {
  const manifest = loadManifest();
  const only = values.only?.split(',');
  const tasks = manifest.tasks.filter((task) => !only || only.includes(task.id));
  const snapshots = await loadSnapshots(tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
  const live = liveProvider(values.config, {
    requests: positiveInteger(values['max-requests'], 600), estimatedInputTokens: positiveInteger(values['max-input-tokens'], 8_000_000),
  });
  const responseTokens = positiveInteger(values['response-tokens'], 3_000);
  const model = values.model ?? 'openai/gpt-5-mini';
  const keyName = values['agent-key-env'] ?? 'AI_GATEWAY_API_KEY';
  const apiKey = process.env[keyName];
  if (!apiKey) throw new Error(`${keyName} is empty or unset`);
  const chat = chatCompletions({ baseUrl: values['agent-base-url'] ?? 'https://ai-gateway.vercel.sh', apiKey, model, prices: agentPrices[model] ?? null });
  const repeats = positiveInteger(values.repeats, 2);
  const maxTurns = positiveInteger(values['max-turns'], 16);
  const jevPrice = live.template.config.provider.pricing?.input_usd_per_million_tokens ?? 0.042;
  const random = mulberry32(positiveInteger(values.seed, 7));
  // Interleave arms in a seeded order so provider drift does not align with one arm.
  const plan = tasks.flatMap((task) => Array.from({ length: repeats }, (_, repeat) => (['baseline', 'jevgrep'] as const).map((arm) => ({ task, repeat, arm }))).flat())
    .map((item) => ({ item, order: random() })).sort((a, b) => a.order - b.order).map(({ item }) => item);
  const host = environment();
  const traces: unknown[] = [];
  const runs = await mapLimit(plan, positiveInteger(values.jobs, 4), async ({ task, repeat, arm }): Promise<AgentRun> => {
    const query = task.queries.find((item) => item.category === 'change-localization')!;
    const issue = query.query.replace(/^[^\n]*\n\n/, '');
    const files = snapshots.get(task.id)!;
    const started = performance.now();
    let initializationMs: number | null = null;
    let space: ReturnType<typeof workspace> | null = null;
    let jevgrep: JevSearch | undefined;
    if (arm === 'jevgrep') {
      space = workspace(files, (base) => live.configure(base, { cache: true }));
      const engine = createSearchEngine({ configuration: space.loaded, provider: live.provider });
      initializationMs = performance.now() - started;
      jevgrep = async (text) => {
        if (live.exhausted()) return { text: 'jevgrep_search unavailable: benchmark budget exhausted', inputTokens: null, costUsd: null, paths: [] };
        const { outcome } = await engine.search({ query: text, scope: ['.'], max_context_tokens: responseTokens });
        if (!('report' in outcome)) return { text: `jevgrep_search error: ${outcome.error.code}`, inputTokens: null, costUsd: null, paths: [] };
        const tokens = outcome.report.usage.provider_input_tokens_reported;
        return {
          text: outcome.excerpts.length === 0 ? `no relevant excerpts (status ${outcome.status})`
            : outcome.excerpts.map((excerpt) => `${excerpt.path}:${excerpt.start_line}-${excerpt.end_line} (score ${excerpt.score.toFixed(2)})\n${excerpt.code}`).join('\n\n'),
          inputTokens: tokens, costUsd: outcome.report.usage.reported_cost_usd ?? (tokens === null ? null : tokens * jevPrice / 1e6),
          paths: outcome.excerpts.map((excerpt) => excerpt.path),
        };
      };
    }
    try {
      console.error(`Agent ${task.id} ${arm} #${repeat}`);
      const trace = await runAgent({ model: chat, files, issue, maxTurns, ...(jevgrep ? { jevgrep } : {}) });
      const score = trace.status === 'submitted' ? scoreSubmission(trace.submitted, query.evidence) : null;
      traces.push({ task: task.id, arm, repeat, submitted: trace.submitted, events: trace.events, error: trace.error });
      console.error(`  ${task.id} ${arm} #${repeat} ${trace.status} success=${score?.success ?? '-'} tools=${trace.toolCalls} jev=${trace.jevCalls}`);
      const totalCostUsd = trace.agentCostUsd === null || trace.jevCostUsd === null ? null : trace.agentCostUsd + trace.jevCostUsd;
      return {
        task: task.id, repository: task.repository, arm: arm as Arm, repeat, status: trace.status, error: trace.error,
        success: score?.success ?? (trace.status === 'error' ? null : false), fileHit: score?.fileHit ?? (trace.status === 'error' ? null : false),
        toolCalls: trace.toolCalls, turns: trace.turns, filesOpened: trace.filesOpened, fileRereads: trace.fileRereads, jevCalls: trace.jevCalls,
        agentInputTokens: trace.agentInputTokens, agentOutputTokens: trace.agentOutputTokens, agentCostUsd: trace.agentCostUsd,
        jevInputTokens: trace.jevInputTokens, jevCostUsd: trace.jevCostUsd, totalCostUsd,
        latencyMs: performance.now() - started, initializationMs,
      };
    } finally {
      space?.cleanup();
    }
  });
  const current = environment();
  const report = {
    schemaVersion: 1, kind: 'paired-agent', createdAt: new Date().toISOString(), environment: host,
    sourceStable: current.sourceHash === host.sourceHash && current.harnessHash === host.harnessHash,
    dataset: { version: manifest.version, hash: digest(tasks), tasks: tasks.map((task) => ({ id: task.id, repository: task.repository, split: task.split, baseCommit: task.baseCommit })) },
    settings: {
      agent: { model, prices: agentPrices[model] ?? null, maxTurns, systemPrompt, tools: 'list_files, grep, read_file, submit_locations (+ jevgrep_search in the jevgrep arm)' },
      jev: live.settings, responseTokens, repeats, caps: live.caps, scoreCache: 'enabled within one run, fresh per run',
    },
    semantics: {
      task: 'change localization: submit up to 5 pre-change ranges; success when one overlaps a required patch unit within 3 lines',
      update: 'not measured: tasks are read-only, so no index update occurs',
      initialization: 'workspace and engine setup before the agent starts; JevGrep preparation happens inside each search and is part of latency',
      cost: 'agent cost from list prices and reported tokens; Jev cost from reported tokens at the configured price; unknown usage makes the total unknown',
    },
    usage: live.usage, analysis: analyzePairedRuns(runs), runs, traces,
  };
  const path = writeReport(values.output ?? 'benchmark-results/agent.json', report);
  console.log(JSON.stringify(report.analysis.overall, null, 2));
  console.log(`Report: ${path}`);
  if (runs.some((run) => run.status === 'error')) process.exitCode = 1;
}
