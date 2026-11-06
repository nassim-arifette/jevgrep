/**
 * Local stdio MCP server (JG-024).
 *
 * A thin adapter over the shared engine: it validates protocol framing, exposes two
 * tools (one question, or several sharing one preparation), and maps outcomes onto
 * MCP results: a text block and `structuredContent` with the same validated payload,
 * plus `notifications/progress` when the client sent a progress token. It contains no search logic (requirement
 * R10) and it cannot widen authorization — the tool schema has no root, credential,
 * endpoint, model or cap field, and a client root hint is a hint, not a grant
 * (specification sections 4.1 and 5.1).
 *
 * This development transport implements stdio framing directly. SDK selection and
 * real Codex interoperability remain open in JG-006; local tests are not client
 * qualification. Live tool calls still require explicit repository authorization,
 * remote enablement and a provider credential.
 *
 * Lifecycle rules enforced here:
 * - startup scans nothing and contacts no provider; the tool is discoverable offline;
 * - `complete` and `partial` are `isError: false`; `rejected` and `error` are `isError: true`;
 * - one active search, one queued search, then `BUSY`;
 * - a cancelled call never produces a later result;
 * - closing stdin ends the process cleanly;
 * - an input line is bounded before `JSON.parse()`, even one that never ends;
 * - output a client does not read is bounded: past the limit, or on a stream error,
 *   every call is cancelled and the server stops.
 */
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import { createSearchError } from './contracts.ts';
import type { SearchOutcome } from './contracts.ts';
import type { SearchEngine, SearchProgress } from './engine.ts';
import { createCallScheduler } from './mcp-calls.ts';
import type { CallScheduler } from './mcp-calls.ts';
import { createLineFramer } from './mcp-framing.ts';
import {
  INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, parseRequest,
} from './mcp-jsonrpc.ts';
import type { JsonRpcId, JsonRpcRequest } from './mcp-jsonrpc.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const TOOL_NAME = 'semantic_search_code';
export const MANY_TOOL_NAME = 'semantic_search_code_many';
/** Progress notifications are spaced at least this far apart; the first and the last always go out. */
export const PROGRESS_INTERVAL_MS = 250;

export const TOOL_DESCRIPTION =
  'Search authorized repository code by behavior, responsibility, or concept when exact identifiers are '
  + 'unknown. Returns original excerpts and coverage information under a response budget. Source evaluation '
  + 'is remote when configured. Use normal exact search for a known symbol, path, or literal. Partial coverage '
  + 'and empty selections do not establish absence; inspect the report and continue investigation as needed.';

/** Strict input schema: nothing here can change authorization or operator limits. */
export const TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Behaviour-oriented search question.' },
    scope: {
      type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32,
      description: 'Repository-relative files or directories. Defaults to the whole authorized root.',
    },
    max_context_tokens: {
      type: 'integer', minimum: 1_024,
      description: 'Response budget in reference tokens.',
    },
    allow_partial_scan: {
      type: 'boolean',
      description: 'Allow a deterministic partial scan instead of refusing a scope that exceeds an enabled cap.',
    },
    continuation: {
      type: 'string',
      description: 'Token from continuation.next of a partial result, to evaluate what that search left out without repeating delivered excerpts. Repeat the same query and scope. Continue only when the evidence so far is insufficient.',
    },
    max_input_tokens: {
      type: 'integer', minimum: 1,
      description: 'Search budget: provider input tokens this call may spend. When the scope needs more, the highest-priority fragments are evaluated first and the result is partial with a continuation. Never raises the operator cap.',
    },
    max_cost_usd: {
      type: 'number', minimum: 0,
      description: 'Search budget in USD for this call, from the configured pricing; same partial-result semantics as max_input_tokens.',
    },
    max_search_ms: {
      type: 'integer', minimum: 1,
      description: 'Search budget in wall-clock milliseconds for this call; what was not evaluated in time is reported and can be continued.',
    },
  },
  required: ['query'],
  additionalProperties: false,
});

export const MANY_TOOL_DESCRIPTION =
  'Ask several related questions about the same authorized code in one call. The repository is inventoried and '
  + 'prepared once and every question is evaluated separately, each with its own budget, result and coverage report. '
  + 'Same semantics as semantic_search_code; results come back in the order of the questions.';

/** One question of a multiquestion call: the single tool's arguments, minus the continuation. */
const QUESTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.fromEntries(Object.entries(TOOL_INPUT_SCHEMA.properties).filter(([key]) => key !== 'continuation')),
  required: ['query'],
  additionalProperties: false,
});

export const MANY_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    questions: { type: 'array', items: QUESTION_SCHEMA, minItems: 1, maxItems: 16, description: 'Questions sharing one preparation of the scope.' },
  },
  required: ['questions'],
  additionalProperties: false,
});

const EXCERPT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' },
    text: { type: 'string' }, score: { type: 'number' }, file_sha256: { type: 'string' },
  },
  required: ['path', 'start_line', 'end_line', 'text', 'score', 'file_sha256'],
});

/**
 * The search payload as the client receives it in `structuredContent`: a result or an
 * error, both versioned. Nested report objects are described by the documented
 * contract; the schema names what every client needs to branch on.
 */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    schema_version: { type: 'string' },
    search_id: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'rejected', 'error'] },
    excerpts: { type: 'array', items: EXCERPT_SCHEMA },
    report: { type: 'object', description: 'Scope, coverage, fragment counts, selection, usage, stop reasons and preflight of the search.' },
    continuation: { type: 'object', description: 'Present on a partial result: the token to evaluate what this search left out.' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } },
      required: ['code', 'message', 'retryable'],
    },
  },
  required: ['schema_version', 'search_id', 'status'],
});

export const MANY_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { results: { type: 'array', items: TOOL_OUTPUT_SCHEMA, description: 'One payload per question, in order.' } },
  required: ['results'],
});

/** Longest accepted JSON-RPC line, in UTF-16 code units (an upper bound on its bytes / 3). */
export const MAX_MESSAGE_LENGTH = 1_048_576;
/** Unread output, in bytes, after which the client is treated as gone. */
export const MAX_PENDING_OUTPUT_BYTES = 16_777_216;
/** How long a search still running when the client closes its input may finish before it is cancelled. */
export const MCP_CLOSE_GRACE_MS = 2_000;

export type McpServerOptions = {
  readonly engine: SearchEngine;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly serverVersion: string;
  /** Called once the input stream ends and every in-flight call has settled. */
  readonly onClose?: () => void;
};

const TOOL_LIST = Object.freeze({
  tools: [{
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: TOOL_INPUT_SCHEMA,
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true, title: 'Semantic code search' },
  }, {
    name: MANY_TOOL_NAME,
    description: MANY_TOOL_DESCRIPTION,
    inputSchema: MANY_TOOL_INPUT_SCHEMA,
    outputSchema: MANY_TOOL_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true, title: 'Semantic code search, several questions' },
  }],
});

function initializeResult(params: unknown, serverVersion: string): Record<string, unknown> {
  const requested = ((params ?? {}) as { protocolVersion?: unknown }).protocolVersion;
  const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'jevgrep', version: serverVersion },
    instructions: 'Tools: semantic_search_code (one question) and semantic_search_code_many (several questions, one preparation). '
      + 'Evidence is returned as original excerpts under a response budget, as text and as structuredContent.',
  };
}

/**
 * Run the server until its input ends.
 *
 * Returns a promise that resolves when stdin closed and every pending call settled,
 * which is what the CLI awaits before exiting.
 */
export function runMcpServer(options: McpServerOptions): Promise<void> {
  const { engine, input, output, errorOutput } = options;
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let abandoned = false;

  const log = (line: string): void => {
    errorOutput.write(`${line}\n`);
  };

  const send = (message: unknown): void => {
    if (abandoned) return;
    output.write(`${JSON.stringify(message)}\n`);
    if (output.writableLength > MAX_PENDING_OUTPUT_BYTES) abandon('output is not being read');
  };

  const sendError = (id: JsonRpcId | null, code: number, message: string): void => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const calls = createCallScheduler(async (call) => {
    try {
      const onProgress = call.progressToken === undefined ? undefined : progressNotifier(call.progressToken, send, () => engine.clock.nowMs);
      if (call.tool === 'search_many') {
        const questions = ((call.arguments ?? {}) as { questions?: unknown }).questions;
        const outcomes = await engine.searchMany(Array.isArray(questions) ? questions : [questions], {
          signal: call.controller.signal, ...(onProgress === undefined ? {} : { onProgress }),
        });
        if (!call.controller.signal.aborted) {
          send({ jsonrpc: '2.0', id: call.id, result: manyToolResult(outcomes.map((entry) => entry.outcome)) });
        }
        return;
      }
      const { outcome } = await engine.search(call.arguments, {
        signal: call.controller.signal, startedAtMs: call.startedAtMs, ...(onProgress === undefined ? {} : { onProgress }),
      });
      if (!call.controller.signal.aborted) {
        send({ jsonrpc: '2.0', id: call.id, result: toolResult(outcome) });
      }
    } catch {
      log('jevgrep mcp tool failure');
      if (!call.controller.signal.aborted) {
        sendError(call.id, INTERNAL_ERROR, 'the search failed before a report could be produced');
      }
    }
  });

  // The client stopped reading or the stream broke: nothing more can be delivered, so
  // cancel every call and stop reading instead of buffering without bound.
  const abandon = (reason: string): void => {
    if (abandoned) return;
    abandoned = true;
    log(`jevgrep mcp stopped: ${reason}`);
    calls.cancelAll();
    input.destroy();
  };
  output.on('error', () => {
    abandon('output stream failed');
  });

  const handle = createRequestRouter({
    send, sendError, calls, serverVersion: options.serverVersion, nowMs: () => engine.clock.nowMs,
    track: (pending) => {
      inFlight.add(pending);
      void pending.finally(() => inFlight.delete(pending));
    },
  });

  const consume = (line: string): void => {
    const parsed = parseRequest(line);
    if (parsed.kind === 'request') {
      handle(parsed.request);
    } else if (parsed.kind === 'invalid') {
      sendError(parsed.id, parsed.code, parsed.message);
      if (parsed.code === PARSE_ERROR) log('jevgrep mcp received an unparsable message');
    }
  };

  const framer = createLineFramer({
    maxLength: MAX_MESSAGE_LENGTH,
    onLine: consume,
    onOversized: () => {
      sendError(null, INVALID_REQUEST, 'message too large');
      log('jevgrep mcp discarded an oversized message');
    },
    stopped: () => abandoned,
  });

  return new Promise<void>((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => framer.push(chunk));
    const finish = (): void => {
      if (closed) return;
      closed = true;
      const rest = framer.flush();
      if (rest !== null && !abandoned) consume(rest);
      // A closed input is the client's shutdown request (MCP lifecycle): nothing new
      // is admitted and a queued search never starts, so no provider work is bought
      // for a client that is leaving. The running call may still finish within a
      // grace period, since its response can still be delivered; past it, it is
      // cancelled so the process exits.
      calls.drain();
      const grace = setTimeout(() => { calls.cancelAll(); }, MCP_CLOSE_GRACE_MS);
      grace.unref();
      void Promise.allSettled(inFlight).then(() => {
        clearTimeout(grace);
        options.onClose?.();
        resolve();
      });
    };
    input.on('end', finish);
    input.on('close', finish);
  });
}

type RouterDeps = {
  readonly send: (message: unknown) => void;
  readonly sendError: (id: JsonRpcId | null, code: number, message: string) => void;
  readonly calls: CallScheduler;
  readonly serverVersion: string;
  readonly nowMs: () => number;
  readonly track: (pending: Promise<void>) => void;
};

/** Admit one tools/call: unknown tool, duplicate id and a full queue answer at once. */
function startToolCall(id: JsonRpcId, params: unknown, deps: RouterDeps): Promise<void> {
  const { send, sendError, calls } = deps;
  const record = (params ?? {}) as Record<string, unknown>;
  const tool = record['name'] === TOOL_NAME ? 'search' : record['name'] === MANY_TOOL_NAME ? 'search_many' : null;
  if (tool === null) {
    sendError(id, INVALID_PARAMS, 'unknown tool');
    return Promise.resolve();
  }
  const token = ((record['_meta'] ?? {}) as { progressToken?: unknown }).progressToken;
  const progressToken = typeof token === 'string' || typeof token === 'number' ? token : undefined;
  if (calls.has(id)) {
    sendError(id, INVALID_REQUEST, 'request id is already in use');
    return Promise.resolve();
  }
  if (calls.isFull()) {
    send({ jsonrpc: '2.0', id, result: toolResult(createSearchError('BUSY', randomUUID())) });
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    calls.submit({
      id, tool, ...(progressToken === undefined ? {} : { progressToken }), startedAtMs: deps.nowMs(), controller: new AbortController(),
      arguments: record['arguments'] ?? {}, resolve,
    });
  });
}

/** Method dispatch for validated requests; requests without an id get no reply. */
function createRequestRouter(deps: RouterDeps): (message: JsonRpcRequest) => void {
  const { send, sendError, calls } = deps;
  return (message) => {
    const id = message.id ?? null;
    if (id === null && !message.method.startsWith('notifications/')) return;
    switch (message.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id, result: initializeResult(message.params, deps.serverVersion) });
        return;
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: TOOL_LIST });
        return;
      case 'tools/call':
        if (id !== null) deps.track(startToolCall(id, message.params, deps));
        return;
      case 'notifications/cancelled': {
        const requestId = ((message.params ?? {}) as { requestId?: unknown }).requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') calls.cancel(requestId);
        return;
      }
      default:
        if (id !== null) sendError(id, METHOD_NOT_FOUND, 'unsupported method');
    }
  };
}

/** One text block and `structuredContent` holding the validated payload; `isError` follows the outcome status. */
export function toolResult(outcome: SearchOutcome): { content: { type: 'text'; text: string }[]; structuredContent: SearchOutcome; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome) }],
    structuredContent: outcome,
    isError: outcome.status === 'rejected' || outcome.status === 'error',
  };
}

/** The multiquestion payload: one text block per question and the results in order; `isError` when every question failed. */
export function manyToolResult(outcomes: readonly SearchOutcome[]): {
  content: { type: 'text'; text: string }[]; structuredContent: { results: readonly SearchOutcome[] }; isError: boolean;
} {
  return {
    content: outcomes.map((outcome) => ({ type: 'text', text: JSON.stringify(outcome) })),
    structuredContent: { results: outcomes },
    isError: outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'rejected' || outcome.status === 'error'),
  };
}

/**
 * `notifications/progress` for one call: `progress` counts fragments with a known
 * score, `total` the fragments to evaluate once known. Notifications are spaced by
 * `PROGRESS_INTERVAL_MS`, except the first one and the one that reaches the total.
 */
export function progressNotifier(
  progressToken: string | number, send: (message: unknown) => void, nowMs: () => number,
): (progress: SearchProgress) => void {
  let lastSentAt: number | null = null;
  return (progress) => {
    const now = nowMs();
    const final = progress.total !== null && progress.evaluated >= progress.total;
    if (lastSentAt !== null && !final && now - lastSentAt < PROGRESS_INTERVAL_MS) return;
    lastSentAt = now;
    send({
      jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken, progress: progress.evaluated, ...(progress.total === null ? {} : { total: progress.total }), message: progress.message },
    });
  };
}
