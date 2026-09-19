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
 * qualification. The executable remains gated until the senior acceptance work.
 *
 * Lifecycle rules enforced here:
 * - startup scans nothing and contacts no provider; the tool is discoverable offline;
 * - `complete` and `partial` are `isError: false`; `rejected` and `error` are `isError: true`;
 * - one active search, one queued search, then `BUSY`;
 * - a cancelled call never produces a later result;
 * - closing stdin ends the process cleanly.
 */
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import { createSearchError } from './contracts.ts';
import type { SearchOutcome } from './contracts.ts';
import type { SearchEngine } from './engine.ts';

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

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export type McpServerOptions = {
  readonly engine: SearchEngine;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly serverVersion: string;
  /** Called once the input stream ends and every in-flight call has settled. */
  readonly onClose?: () => void;
};

type ActiveCall = {
  readonly id: JsonRpcId;
  readonly controller: AbortController;
  readonly arguments: unknown;
  readonly resolve: () => void;
};

/**
 * Run the server until its input ends.
 *
 * Returns a promise that resolves when stdin closed and every pending call settled,
 * which is what the CLI awaits before exiting.
 */
export function runMcpServer(options: McpServerOptions): Promise<void> {
  const { engine, input, output, errorOutput } = options;
  const active = new Map<string, ActiveCall>();
  const inFlight = new Set<Promise<void>>();
  let running: ActiveCall | null = null;
  let queued: ActiveCall | null = null;
  let buffer = '';
  let closed = false;

  const log = (line: string): void => {
    errorOutput.write(`${line}\n`);
  };

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const sendError = (id: JsonRpcId | null, code: number, message: string): void => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  // Keep numeric and string ids distinct, including while a call is queued.
  const callKey = (id: JsonRpcId): string => JSON.stringify(id);

  const execute = async (call: ActiveCall): Promise<void> => {
    running = call;
    try {
      const { outcome } = await engine.search(call.arguments, { signal: call.controller.signal });
      if (!call.controller.signal.aborted) {
        send({ jsonrpc: '2.0', id: call.id, result: toolResult(outcome) });
      }
    } catch {
      log('jevgrep mcp tool failure');
      if (!call.controller.signal.aborted) {
        sendError(call.id, INTERNAL_ERROR, 'the search failed before a report could be produced');
      }
    } finally {
      active.delete(callKey(call.id));
      running = null;
      call.resolve();
      if (queued !== null) {
        const next = queued;
        queued = null;
        void execute(next);
      }
    }
  };

  const handleToolCall = (id: JsonRpcId, params: unknown): Promise<void> => {
    const record = (params ?? {}) as Record<string, unknown>;
    if (record['name'] !== TOOL_NAME) {
      sendError(id, INVALID_PARAMS, 'unknown tool');
      return Promise.resolve();
    }
    if (active.has(callKey(id))) {
      sendError(id, INVALID_REQUEST, 'request id is already in use');
      return Promise.resolve();
    }

    // One active search and one queued search; anything beyond that is BUSY
    // (specification section 6.3).
    if (running !== null && queued !== null) {
      send({
        jsonrpc: '2.0', id,
        result: toolResult(createSearchError('BUSY', randomUUID())),
      });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const call: ActiveCall = { id, controller: new AbortController(), arguments: record['arguments'] ?? {}, resolve };
      active.set(callKey(id), call);
      if (running === null) void execute(call);
      else queued = call;
    });
  };

  const handle = (message: JsonRpcRequest): void => {
    const id = message.id ?? null;
    if (id === null && !message.method.startsWith('notifications/')) return;
    switch (message.method) {
      case 'initialize': {
        const requested = ((message.params ?? {}) as { protocolVersion?: unknown }).protocolVersion;
        const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested : MCP_PROTOCOL_VERSION;
        send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'jevgrep', version: options.serverVersion },
            instructions: 'One tool: semantic_search_code. Evidence is returned as original excerpts under a response budget.',
          },
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({
          jsonrpc: '2.0', id,
          result: {
            tools: [{
              name: TOOL_NAME,
              description: TOOL_DESCRIPTION,
              inputSchema: TOOL_INPUT_SCHEMA,
              annotations: { readOnlyHint: true, openWorldHint: true, title: 'Semantic code search' },
            }],
          },
        });
        return;
      case 'tools/call': {
        if (id === null) {
          return;
        }
        const pending = handleToolCall(id, message.params);
        inFlight.add(pending);
        void pending.finally(() => inFlight.delete(pending));
        return;
      }
      case 'notifications/cancelled': {
        const requestId = ((message.params ?? {}) as { requestId?: unknown }).requestId;
        if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
        const call = active.get(callKey(requestId));
        call?.controller.abort();
        if (call !== undefined && queued === call) {
          queued = null;
          active.delete(callKey(call.id));
          call.resolve();
        }
        return;
      }
      default:
        if (id !== null) sendError(id, METHOD_NOT_FOUND, 'unsupported method');
    }
  };

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendError(null, PARSE_ERROR, 'invalid JSON message');
      log('jevgrep mcp received an unparsable message');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message');
      return;
    }
    const record = parsed as Record<string, unknown>;
    const id = record['id'];
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    if (record['jsonrpc'] !== '2.0' || typeof record['method'] !== 'string'
      || (Object.hasOwn(record, 'id') && !validId)) {
      sendError(validId ? id : null, INVALID_REQUEST, 'invalid JSON-RPC request');
      return;
    }
    const params = record['params'];
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      if (validId) sendError(id, INVALID_PARAMS, 'expected object parameters');
      return;
    }
    const message = parsed as JsonRpcRequest;
    if (typeof message.method !== 'string') {
      sendError(message.id ?? null, INVALID_REQUEST, 'missing method');
      return;
    }
    handle(message);
  };

  return new Promise<void>((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
        newline = buffer.indexOf('\n');
      }
    });
    const finish = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (buffer.trim().length > 0) {
        consume(buffer);
        buffer = '';
      }
      // Let pending calls settle so the process never exits mid-response.
      void Promise.allSettled([...inFlight]).then(() => {
        options.onClose?.();
        resolve();
      });
    };
    input.on('end', finish);
    input.on('close', finish);
  });
}

/** One text block holding the validated payload; `isError` follows the outcome status. */
export function toolResult(outcome: SearchOutcome): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome) }],
    isError: outcome.status === 'rejected' || outcome.status === 'error',
  };
}
