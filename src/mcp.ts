/**
 * Local stdio MCP server (JG-024).
 *
 * A thin adapter over the shared engine: it validates protocol framing, exposes one
 * tool, and maps outcomes onto MCP results. It contains no search logic (requirement
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
import type { SearchEngine } from './engine.ts';
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
  },
  required: ['query'],
  additionalProperties: false,
});

/** Longest accepted JSON-RPC line, in UTF-16 code units (an upper bound on its bytes / 3). */
export const MAX_MESSAGE_LENGTH = 1_048_576;
/** Unread output, in bytes, after which the client is treated as gone. */
export const MAX_PENDING_OUTPUT_BYTES = 16_777_216;

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
    annotations: { readOnlyHint: true, openWorldHint: true, title: 'Semantic code search' },
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
    instructions: 'One tool: semantic_search_code. Evidence is returned as original excerpts under a response budget.',
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
      const { outcome } = await engine.search(call.arguments, {
        signal: call.controller.signal, startedAtMs: call.startedAtMs,
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
      // Let pending calls settle so the process never exits mid-response.
      void Promise.allSettled(inFlight).then(() => {
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
  if (record['name'] !== TOOL_NAME) {
    sendError(id, INVALID_PARAMS, 'unknown tool');
    return Promise.resolve();
  }
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
      id, startedAtMs: deps.nowMs(), controller: new AbortController(),
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

/** One text block holding the validated payload; `isError` follows the outcome status. */
export function toolResult(outcome: SearchOutcome): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome) }],
    isError: outcome.status === 'rejected' || outcome.status === 'error',
  };
}
