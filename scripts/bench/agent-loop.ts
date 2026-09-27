import type { Evidence } from './dataset.ts';

/** Minimal OpenAI-compatible chat surface; tests inject a scripted model. */
export type ToolCall = { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } };
export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };
export type ToolSpec = { readonly type: 'function'; readonly function: { readonly name: string; readonly description: string; readonly parameters: object } };
export type ChatReply = {
  readonly message: Extract<ChatMessage, { role: 'assistant' }>;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly costUsd: number | null };
};
export type ChatModel = (messages: readonly ChatMessage[], tools: readonly ToolSpec[]) => Promise<ChatReply>;

export type JevSearch = (query: string) => Promise<{ readonly text: string; readonly inputTokens: number | null; readonly costUsd: number | null; readonly paths: readonly string[] }>;

const lineCap = 200;
const grepCap = 40;
const listCap = 300;

const spec = (name: string, description: string, properties: object, required: string[]): ToolSpec =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const baseTools: readonly ToolSpec[] = [
  spec('list_files', `List repository files under a directory prefix (at most ${listCap}).`, { prefix: { type: 'string' } }, ['prefix']),
  spec('grep', `Search files with a JavaScript regular expression; returns at most ${grepCap} matching lines as path:line: text.`,
    { pattern: { type: 'string' }, path_prefix: { type: 'string' } }, ['pattern', 'path_prefix']),
  spec('read_file', `Read numbered lines of a file (at most ${lineCap} lines per call).`,
    { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, ['path', 'start_line', 'end_line']),
  spec('submit_locations', 'Finish: submit up to 5 existing code ranges that must change to resolve the issue.', {
    locations: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['path', 'start_line', 'end_line'],
      properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } } } },
  }, ['locations']),
];

export const jevgrepTool: ToolSpec = spec('jevgrep_search',
  'Semantic code search over the whole repository: returns the most relevant source excerpts with paths and line numbers for a natural-language question. Each call scans the whole repository.',
  { query: { type: 'string' } }, ['query']);

export const systemPrompt = [
  'You localize bugs in a Python repository checked out at the commit before the fix.',
  'Find the existing code ranges that must be edited to resolve the issue. Use the tools; do not guess paths.',
  'When confident, call submit_locations with at most 5 precise ranges from the current files. Do not write a patch.',
].join(' ');

export type AgentTrace = {
  readonly status: 'submitted' | 'no_submission' | 'error';
  readonly error: string | null;
  readonly submitted: readonly Evidence[];
  readonly toolCalls: number; readonly turns: number; readonly jevCalls: number;
  readonly filesOpened: number; readonly fileRereads: number;
  readonly agentInputTokens: number | null; readonly agentOutputTokens: number | null; readonly agentCostUsd: number | null;
  readonly jevInputTokens: number | null; readonly jevCostUsd: number | null;
  readonly events: readonly { readonly tool: string; readonly args: string; readonly resultBytes: number; readonly ms: number }[];
};

type ToolArgs = {
  readonly prefix?: unknown; readonly pattern?: unknown; readonly path_prefix?: unknown; readonly path?: unknown;
  readonly start_line?: unknown; readonly end_line?: unknown; readonly query?: unknown; readonly locations?: unknown;
};

/** Sum that turns unknown if any contribution is unknown. */
const add = (total: number | null, value: number | null): number | null => total === null || value === null ? null : total + value;

/** Run one tool-using episode against a read-only in-memory snapshot. */
export async function runAgent(options: {
  readonly model: ChatModel; readonly files: Readonly<Record<string, string>>; readonly issue: string;
  readonly jevgrep?: JevSearch; readonly maxTurns?: number;
}): Promise<AgentTrace> {
  const paths = Object.keys(options.files);
  const tools = options.jevgrep ? [...baseTools.slice(0, 3), jevgrepTool, baseTools[3]!] : baseTools;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Issue:\n\n${options.issue.trim()}` }];
  const readRanges = new Map<string, [number, number][]>();
  const events: { tool: string; args: string; resultBytes: number; ms: number }[] = [];
  let usage = { input: 0 as number | null, output: 0 as number | null, cost: 0 as number | null, jevInput: 0 as number | null, jevCost: 0 as number | null };
  let toolCalls = 0; let jevCalls = 0; let rereads = 0; let turns = 0;
  const finish = (status: AgentTrace['status'], submitted: readonly Evidence[], error: string | null = null): AgentTrace => ({
    status, error, submitted, toolCalls, turns, jevCalls, filesOpened: readRanges.size, fileRereads: rereads,
    agentInputTokens: usage.input, agentOutputTokens: usage.output, agentCostUsd: usage.cost,
    jevInputTokens: options.jevgrep ? usage.jevInput : 0, jevCostUsd: options.jevgrep ? usage.jevCost : 0, events,
  });
  const execute = async (name: string, args: ToolArgs): Promise<string> => {
    if (name === 'list_files') {
      const prefix = String(args.prefix ?? '').replace(/^\.?\//, '');
      const hits = paths.filter((path) => path.startsWith(prefix));
      return hits.slice(0, listCap).join('\n') + (hits.length > listCap ? `\n... ${hits.length - listCap} more` : '') || 'no files';
    }
    if (name === 'grep') {
      let pattern: RegExp;
      try { pattern = new RegExp(String(args.pattern)); } catch { return 'invalid regular expression'; }
      const prefix = String(args.path_prefix ?? '').replace(/^\.?\//, '');
      const hits: string[] = [];
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        options.files[path]!.split(/\r?\n/).forEach((line, index) => {
          if (hits.length <= grepCap && pattern.test(line)) hits.push(`${path}:${index + 1}: ${line.slice(0, 200)}`);
        });
        if (hits.length > grepCap) break;
      }
      return hits.length === 0 ? 'no matches' : hits.slice(0, grepCap).join('\n') + (hits.length > grepCap ? '\n... truncated' : '');
    }
    if (name === 'read_file') {
      const path = String(args.path ?? '').replace(/^\.?\//, '');
      const text = options.files[path];
      if (text === undefined) return 'no such file';
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Math.trunc(Number(args.start_line) || 1));
      const end = Math.min(lines.length, Math.trunc(Number(args.end_line) || start + lineCap - 1), start + lineCap - 1);
      const previous = readRanges.get(path) ?? [];
      if (previous.some(([a, b]) => a <= end && b >= start)) rereads += 1;
      readRanges.set(path, [...previous, [start, end]]);
      return lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n') + `\n(${lines.length} lines total)`;
    }
    if (name === 'jevgrep_search' && options.jevgrep) {
      jevCalls += 1;
      const result = await options.jevgrep(String(args.query ?? ''));
      usage = { ...usage, jevInput: add(usage.jevInput, result.inputTokens), jevCost: add(usage.jevCost, result.costUsd) };
      return result.text;
    }
    return `unknown tool ${name}`;
  };
  try {
    for (; turns < (options.maxTurns ?? 16);) {
      turns += 1;
      const reply = await options.model(messages, tools);
      usage = { ...usage, input: add(usage.input, reply.usage.inputTokens), output: add(usage.output, reply.usage.outputTokens), cost: add(usage.cost, reply.usage.costUsd) };
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      if (calls.length === 0) {
        messages.push({ role: 'user', content: 'Use the tools, then call submit_locations.' });
        continue;
      }
      for (const call of calls) {
        toolCalls += 1;
        let args: ToolArgs;
        try { args = JSON.parse(call.function.arguments) as ToolArgs; } catch { args = {}; }
        if (call.function.name === 'submit_locations') {
          const submitted = (Array.isArray(args.locations) ? args.locations : []).slice(0, 5).flatMap((item: unknown) => {
            const value = item as { path?: unknown; start_line?: unknown; end_line?: unknown };
            return typeof value.path === 'string' && Number.isInteger(value.start_line) && Number.isInteger(value.end_line)
              ? [{ path: value.path.replace(/^\.?\//, ''), startLine: value.start_line as number, endLine: value.end_line as number }] : [];
          });
          return finish('submitted', submitted);
        }
        const started = performance.now();
        const content = await execute(call.function.name, args);
        events.push({ tool: call.function.name, args: call.function.arguments.slice(0, 500), resultBytes: Buffer.byteLength(content), ms: performance.now() - started });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    return finish('no_submission', []);
  } catch (cause) {
    return finish('error', [], cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
  }
}

/** OpenAI-compatible Chat Completions client with rate-limit backoff. */
export function chatCompletions(options: { readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly prices: { readonly input: number; readonly output: number } | null; readonly maxAttempts?: number }): ChatModel {
  return async (messages, tools) => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model, messages, tools, tool_choice: 'auto' }),
        signal: AbortSignal.timeout(180_000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < (options.maxAttempts ?? 8)) {
        const retry = Number(response.headers.get('retry-after'));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2000 * attempt));
        continue;
      }
      if (!response.ok) throw new Error(`chat HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = await response.json() as { choices: { message: ChatReply['message'] }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const input = body.usage?.prompt_tokens ?? null;
      const output = body.usage?.completion_tokens ?? null;
      const message = body.choices[0]!.message;
      return {
        message: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
        usage: { inputTokens: input, outputTokens: output, costUsd: options.prices && input !== null && output !== null ? input * options.prices.input + output * options.prices.output : null },
      };
    }
  };
}
