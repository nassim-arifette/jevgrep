/**
 * A real coding agent (Claude Code, `claude -p`) answering the pinned real-task
 * questions on a snapshot, with its built-in file tools only (`baseline`) or with
 * JevGrep added as an MCP server (`jevgrep`). The agent must answer with locations;
 * they are scored like every other arm. Cost, tokens, turns and time come from the
 * CLI's JSON result.
 *
 *   node scripts/bench-claude-agent.ts --config <trusted-jev-config> [--go-rust] [--only id,id] \
 *     [--arms baseline,jevgrep] [--model claude-opus-5-5] [--effort medium] [--output file.json]
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import { liveProvider } from './bench/live-provider.ts';
import { loadManifest, mapLimit, systemsManifestPath } from './bench/real-tasks.ts';
import { localizationRangeMetrics, type Range } from './bench/retrieval.ts';
import { loadSnapshots } from './bench/snapshots.ts';
import { mean, quantile } from './bench/report.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, output: { type: 'string' }, mirrors: { type: 'string' }, only: { type: 'string' }, arms: { type: 'string' },
  model: { type: 'string' }, effort: { type: 'string' }, jobs: { type: 'string' }, 'max-turns': { type: 'string' }, 'go-rust': { type: 'boolean' },
} });
if (values.config === undefined) throw new Error('--config <trusted-jev-config> is required');
const arms = (values.arms ?? 'baseline,jevgrep').split(',') as ('baseline' | 'jevgrep')[];
const model = values.model ?? 'claude-opus-5-5';
const effort = values.effort ?? 'medium';
const maxTurns = positiveInteger(values['max-turns'], 40);
const manifest = values['go-rust'] ? loadManifest(systemsManifestPath, {}) : loadManifest();
const only = values.only?.split(',');
const tasks = manifest.tasks.filter((task) => !only || only.includes(task.id));
const snapshots = await loadSnapshots(tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
const live = liveProvider(values.config, { requests: 2_000, estimatedInputTokens: 50_000_000 });
const run = promisify(execFile);

const PROMPT = (question: string): string => `${question}

Find where in this repository the code that answers this lives. Work from the current directory, which is the repository root.
When you are done, reply with JSON only, no prose: {"locations":[{"path":"<relative path>","start_line":<int>,"end_line":<int>}]}
List up to 10 locations, best first, each a function-sized region (at most about 60 lines). Do not modify any file.`;

type Row = {
  arm: string; id: string; task: string; complete: boolean; error: string | null; ranges: Range[];
  metrics: ReturnType<typeof localizationRangeMetrics> | null; durationMs: number; apiMs: number | null; costUsd: number | null;
  turns: number | null; inputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null;
  outputTokens: number | null; thinkingTokens: number | null; jevSearches: number | null; jevInputTokens: number | null; toolCalls?: string[];
};

async function agent(arm: 'baseline' | 'jevgrep', task: typeof tasks[number], query: typeof tasks[number]['queries'][number]): Promise<Row> {
  const files = snapshots.get(task.id)!;
  const space = workspace(files, (base) => live.configure(base, { cache: true }));
  const base = { arm, id: query.id, task: task.id };
  const started = performance.now();
  try {
    const tools = ['Read', 'Grep', 'Glob', 'LS', 'Bash(rg *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(sed -n *)', 'Bash(wc *)'];
    const prompt = arm === 'jevgrep'
      ? `${PROMPT(query.query)}\nStart by calling the MCP tool semantic_search_code with the question (rephrase and call it again if the first results do not answer it); read files only to confirm.`
      : PROMPT(query.query);
    const args = ['-p', prompt, '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns),
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--disable-slash-commands'];
    const mcpEnv = { ...process.env, JEVGREP_CACHE_HOME: join(space.loaded.configPath, '..', 'cache') };
    if (arm === 'jevgrep') {
      const mcpConfig = join(space.loaded.configPath, '..', 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { jevgrep: {
        command: process.execPath, args: [join(projectRoot, 'dist/cli.js'), 'mcp', '--config', space.loaded.configPath],
        env: { TYPESAFE_API_KEY: process.env['TYPESAFE_API_KEY'] ?? '', JEVGREP_CACHE_HOME: mcpEnv.JEVGREP_CACHE_HOME },
      } } }));
      args.push('--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', ...tools, 'mcp__jevgrep__*',
        '--append-system-prompt', 'This repository provides the MCP tool semantic_search_code (server jevgrep): it finds code from a description of what it does and returns verbatim excerpts with paths and line numbers. Start with it for any question about behaviour, then read files only to confirm.');
    } else {
      args.push('--strict-mcp-config', '--allowedTools', ...tools);
    }
    const { stdout } = await run('claude', args, { cwd: space.repository, env: mcpEnv, maxBuffer: 1 << 26, timeout: 20 * 60_000 });
    const events = stdout.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = events.find((event) => event['type'] === 'result') ?? {};
    const toolCalls: string[] = [];
    for (const event of events) {
      if (event['type'] !== 'assistant') continue;
      const content = ((event['message'] as { content?: { type: string; name?: string }[] } | undefined)?.content) ?? [];
      for (const part of content) if (part.type === 'tool_use' && part.name !== undefined) toolCalls.push(part.name);
    }
    const jevCalls = toolCalls.filter((name) => name.startsWith('mcp__jevgrep__')).length;
    const init = events.find((event) => event['type'] === 'system' && event['subtype'] === 'init');
    const mcpStatus = init === undefined ? null : JSON.stringify(init['mcp_servers'] ?? null);
    const denials = JSON.stringify(result['permission_denials'] ?? null).slice(0, 300);
    const text = String(result['result'] ?? '');
    const match = /\{[\s\S]*\}/.exec(text);
    const located = match === null ? [] : ((JSON.parse(match[0]) as { locations?: { path: string; start_line: number; end_line: number }[] }).locations ?? []);
    const ranges: Range[] = [];
    for (const location of located) {
      const lines = files[location.path.replace(/^\.\//, '')]?.split('\n').length;
      if (lines === undefined) continue;
      const start = Math.max(1, Math.min(location.start_line, lines));
      ranges.push({ path: location.path.replace(/^\.\//, ''), start_line: start, end_line: Math.max(start, Math.min(location.end_line, lines)) });
      if (ranges.length >= 10) break;
    }
    const usage = (result['usage'] ?? {}) as Record<string, number | Record<string, number>>;
    const tokensOf = (key: string): number | null => typeof usage[key] === 'number' ? usage[key] : null;
        console.error(`${arm} ${query.id} ${String(ranges.length)} locations, ${String(result['num_turns'])} turns, ${String(toolCalls.length)} tool calls (${String(jevCalls)} jevgrep), $${String(result['total_cost_usd'])}, ${Math.round(performance.now() - started)} ms; mcp ${String(mcpStatus)}; denials ${denials}`);
    return { ...base, complete: true, error: null, ranges, metrics: localizationRangeMetrics(query, ranges),
      durationMs: performance.now() - started, apiMs: typeof result['duration_api_ms'] === 'number' ? result['duration_api_ms'] : null,
      costUsd: typeof result['total_cost_usd'] === 'number' ? result['total_cost_usd'] : null,
      turns: typeof result['num_turns'] === 'number' ? result['num_turns'] : null,
      inputTokens: tokensOf('input_tokens'), cacheReadTokens: tokensOf('cache_read_input_tokens'), cacheCreationTokens: tokensOf('cache_creation_input_tokens'),
      outputTokens: tokensOf('output_tokens'), thinkingTokens: (usage['output_tokens_details'] as Record<string, number> | undefined)?.['thinking_tokens'] ?? null,
      jevSearches: jevCalls, jevInputTokens: null, toolCalls };
  } catch (cause) {
    console.error(`${arm} ${query.id} error ${String(cause).slice(0, 300)}`);
    return { ...base, complete: false, error: String(cause).slice(0, 500), ranges: [], metrics: null, durationMs: performance.now() - started,
      apiMs: null, costUsd: null, turns: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null,
      thinkingTokens: null, jevSearches: null, jevInputTokens: null };
  } finally {
    space.cleanup();
  }
}

const plan = tasks.flatMap((task) => task.queries.flatMap((query) => arms.map((arm) => ({ task, query, arm }))));
const jevBefore = live.usage.reportedInputTokens;
const rows = await mapLimit(plan, positiveInteger(values.jobs, 2), ({ task, query, arm }) => agent(arm, task, query));
const summary = Object.fromEntries(arms.map((arm) => {
  const group = rows.filter((row) => row.arm === arm);
  const done = group.filter((row) => row.metrics !== null);
  const pick = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'fileRecall') => mean(done.flatMap((row) => row.metrics![key] == null ? [] : [row.metrics![key]!]));
  const sum = (key: keyof Row) => group.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
  return [arm, { questions: group.length, answered: done.length, errors: group.filter((row) => row.error !== null).length,
    recallAt1: pick('recallAt1'), recallAt5: pick('recallAt5'), mrr: pick('reciprocalRank'), fileRecall: pick('fileRecall'),
    costUsdTotal: sum('costUsd'), costUsdPerQuestion: sum('costUsd') / Math.max(1, group.length), turnsPerQuestion: sum('turns') / Math.max(1, group.length),
    toolCallsPerQuestion: group.reduce((total, row) => total + (row.toolCalls?.length ?? 0), 0) / Math.max(1, group.length), jevSearchesPerQuestion: sum('jevSearches') / Math.max(1, group.length),
    tokensPerQuestion: (sum('inputTokens') + sum('cacheReadTokens') + sum('cacheCreationTokens')) / Math.max(1, group.length),
    outputTokensPerQuestion: sum('outputTokens') / Math.max(1, group.length), durationP50Ms: quantile(group.map((row) => row.durationMs), 0.5),
    durationP95Ms: quantile(group.map((row) => row.durationMs), 0.95) }];
}));
const report = { schemaVersion: 1, kind: 'claude-agent-comparison', createdAt: new Date().toISOString(), environment: environment(),
  dataset: { source: manifest.source, version: manifest.version, tasks: tasks.length, questions: plan.length / arms.length },
  settings: { model, effort, maxTurns, jev: live.settings }, jevUsage: { ...live.usage, reportedInputTokensDelta: live.usage.reportedInputTokens - jevBefore },
  summary, rows };
console.log(JSON.stringify(summary, null, 1));
console.log(`Report: ${writeReport(values.output ?? 'benchmark-results/claude-agent.json', report)}`);
