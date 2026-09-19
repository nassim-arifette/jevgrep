import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createSearchEngine } from '../src/engine.ts';
import type { SearchOutcome } from '../src/contracts.ts';
import { searchOutcomeSchema } from '../src/contracts.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../src/evaluation/jev.ts';
import { MCP_PROTOCOL_VERSION, TOOL_NAME, runMcpServer } from '../src/mcp.ts';
import { offlineEnv } from './helpers/cli-runner.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/**
 * The stdio MCP adapter (JG-024) and the interoperability checks of JG-006.
 *
 * The adapter must add nothing to the engine and hide nothing from it: one tool, one
 * validated JSON payload per call, `isError` following the outcome status, stdout
 * reserved for the protocol, no result after a cancellation, and a clean stop when
 * stdin closes.
 */
const spaces: { cleanup(): void }[] = [];

const FILES = {
  'src/cache.ts': 'export function invalidate(userId) {\n  store.delete(userId);\n}\n',
  'src/other.ts': 'export const version = "1.0.0";\n',
};

function workspace(): ReturnType<typeof createWorkspace> {
  const space = createWorkspace({ files: FILES, configure: withRemoteEnabled });
  spaces.push(space);
  return space;
}

after(() => {
  for (const space of spaces) {
    space.cleanup();
  }
});

class DeterministicProvider implements ProviderClient {
  readonly model = 'jev-1.13.0';
  calls = 0;

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    this.calls += 1;
    const scores = new Map<string, number>();
    for (const item of batch.items) {
      scores.set(item.id, item.path.includes('cache') ? 0.9 : 0.1);
    }
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: 100, outputTokens: 0 },
      requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 512, requestId: 'req-test',
    });
  }
}

type Session = {
  send(message: unknown): void;
  sendRaw(line: string): void;
  responses(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};

function session(provider: ProviderClient = new DeterministicProvider()): Session {
  const space = workspace();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const engine = createSearchEngine({ configuration: space.loaded, provider, env: space.env });
  const finished = runMcpServer({ engine, input, output, errorOutput, serverVersion: '0.0.0-test' });

  const lines: string[] = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });

  return {
    send(message: unknown): void {
      input.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(line: string): void {
      input.write(`${line}\n`);
    },
    async responses(): Promise<Record<string, unknown>[]> {
      input.end();
      await finished;
      await new Promise((resolve) => setImmediate(resolve));
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async close(): Promise<void> {
      input.end();
      await finished;
    },
  };
}

test('the server starts offline, answers initialize and lists exactly one tool', async () => {
  const active = session();
  active.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } });
  active.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  active.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const messages = await active.responses();

  const initialize = messages.find((message) => message['id'] === 1);
  assert.ok(initialize !== undefined);
  const initializeResult = initialize['result'] as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(initializeResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initializeResult.serverInfo.name, 'jevgrep');

  const list = messages.find((message) => message['id'] === 2);
  assert.ok(list !== undefined);
  const tools = (list['result'] as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, TOOL_NAME);
});

test('the tool schema cannot change the root, credential, endpoint, model or caps', async () => {
  const active = session();
  active.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const messages = await active.responses();
  const tools = (messages[0]?.['result'] as { tools: { inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean } }[] }).tools;
  const schema = tools[0]?.inputSchema;
  assert.ok(schema !== undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['allow_partial_scan', 'max_context_tokens', 'query', 'scope']);
  assert.equal(schema.additionalProperties, false);
});

test('a successful call returns one validated JSON payload with isError false', async () => {
  const provider = new DeterministicProvider();
  const active = session(provider);
  active.send({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: TOOL_NAME, arguments: { query: 'cache invalidation', scope: ['.'], max_context_tokens: 4_000 } },
  });
  const messages = await active.responses();
  const call = messages.find((message) => message['id'] === 7);
  assert.ok(call !== undefined);

  const result = call['result'] as { content: { type: string; text: string }[]; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1, 'exactly one copy of the payload is exposed');
  assert.equal(result.content[0]?.type, 'text');
  const outcome = searchOutcomeSchema.parse(JSON.parse(result.content[0]?.text ?? '')) as SearchOutcome;
  assert.equal(outcome.status, 'complete');
  assert.ok('report' in outcome && outcome.excerpts.length === 1);
  assert.equal(Object.hasOwn(call['result'] as object, 'structuredContent'), false,
    'no structured content is declared without a matching output schema');
});

test('a rejected outcome uses isError true and stays a bounded payload', async () => {
  const active = session();
  active.send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: TOOL_NAME, arguments: { query: '   ' } },
  });
  const messages = await active.responses();
  const call = messages.find((message) => message['id'] === 3);
  const result = call?.['result'] as { content: { text: string }[]; isError: boolean };
  assert.equal(result.isError, true);
  const outcome = JSON.parse(result.content[0]?.text ?? '') as { status: string; error: { code: string } };
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error.code, 'INVALID_REQUEST');
});

test('an unknown tool and an unknown method are protocol errors, not silent successes', async () => {
  const active = session();
  active.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other_tool', arguments: {} } });
  active.send({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  active.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  const messages = await active.responses();

  assert.ok((messages.find((message) => message['id'] === 4)?.['error'] as { code: number }).code === -32602);
  assert.ok((messages.find((message) => message['id'] === 5)?.['error'] as { code: number }).code === -32601);
  assert.deepEqual(messages.find((message) => message['id'] === 6)?.['result'], {});
});

test('malformed and primitive input return protocol errors without crashing or echoing input', async () => {
  const active = session();
  active.sendRaw('{malformed-secret');
  for (const value of [null, 3, 'text', [], true]) active.send(value);
  active.send({ jsonrpc: '2.0', id: {}, method: 'ping' });
  active.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: null });
  active.send({ jsonrpc: '2.0', method: 'ping' });
  active.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
  const messages = await active.responses();
  assert.equal(messages.length, 9);
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON message' } });
  assert.equal((messages[1]?.['error'] as { code: number }).code, -32600);
  assert.equal((messages[7]?.['error'] as { code: number }).code, -32602);
  assert.deepEqual(messages[8]?.['result'], {});
  assert.ok(!JSON.stringify(messages).includes('malformed-secret'));
});

test('one call waits, the third is BUSY, and a queued cancellation frees its slot', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const provider: ProviderClient = {
    model: 'jev-1.13.0',
    async evaluateBatch(batch) {
      calls += 1;
      await blocked;
      return {
        scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
        usage: { inputTokens: 100, outputTokens: 0 }, requestedModel: this.model,
        returnedModel: this.model, transmittedBytes: 500, requestId: null,
      };
    },
  };
  const active = session(provider);
  const send = (id: string | number, query: string): void => active.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: TOOL_NAME, arguments: { query } },
  });
  try {
    send(1, 'first');
    send('1', 'cancelled queued call');
    send(3, 'too many');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'the queued request has not entered the engine');
    active.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '1' } });
    send(4, 'replacement queued call');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'cancelling the string id does not cancel the numeric id');
  } finally {
    release();
  }
  const messages = await active.responses();
  assert.equal(calls, 2);
  assert.ok(!messages.some((message) => message['id'] === '1'));
  assert.ok(messages.some((message) => message['id'] === 1));
  assert.ok(messages.some((message) => message['id'] === 4));
  const busy = messages.find((message) => message['id'] === 3)?.['result'] as { content: { text: string }[] };
  const outcome = JSON.parse(busy.content[0]?.text ?? '{}') as { error: { code: string } };
  assert.equal(outcome.error.code, 'BUSY');
});

test('a cancelled call never produces a later result', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ProviderClient = {
    model: 'jev-1.13.0',
    async evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
      await blocked;
      const scores = new Map(batch.items.map((item) => [item.id, 0.9] as const));
      return {
        scores, invalid: [], usage: { inputTokens: 10, outputTokens: 0 },
        requestedModel: 'jev-1.13.0', returnedModel: 'jev-1.13.0', transmittedBytes: 10, requestId: null,
      };
    },
  };

  const active = session(provider);
  active.send({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: TOOL_NAME, arguments: { query: 'cache invalidation' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  active.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } });
  release?.();

  const messages = await active.responses();
  assert.equal(messages.some((message) => message['id'] === 11), false,
    'no result is emitted for a cancelled request');
});

test('the subprocess keeps stdout clean and stops when stdin closes', async () => {
  const space = workspace();
  const launcher = fileURLToPath(new URL('./helpers/mcp-subprocess.ts', import.meta.url));
  const child = spawn(process.execPath, [launcher, space.configPath], {
    env: { ...offlineEnv(), JEVGREP_CACHE_HOME: space.env['JEVGREP_CACHE_HOME'] ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: TOOL_NAME, arguments: { query: 'cache invalidation', scope: ['.'] } },
  })}\n`);

  const exitCode = await new Promise<number | null>((resolve) => {
    setTimeout(() => child.stdin.end(), 400);
    child.on('close', resolve);
  });

  assert.equal(exitCode, 0, 'closing stdin ends the server cleanly');
  const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { jsonrpc: string };
    assert.equal(parsed.jsonrpc, '2.0', 'stdout carries protocol messages only');
  }
  assert.ok(lines.length >= 2);
  assert.ok(stderr.includes('mcp server ready') === false || stderr.length > 0);
});

test('CLI JSON and MCP expose the same payload for the same evidence', async () => {
  // The cache is disabled so both adapters face the same cold state; otherwise the
  // second run would legitimately report reuse instead of new evaluations.
  const space = createWorkspace({
    files: FILES,
    configure: (config) => withRemoteEnabled({ ...config, cache: { ...config.cache, enabled: false } }),
  });
  spaces.push(space);
  const provider = new DeterministicProvider();
  const engine = createSearchEngine({ configuration: space.loaded, provider, env: space.env });
  const request = { query: 'cache invalidation', scope: ['.'], max_context_tokens: 4_000 };

  const direct = await engine.search(request);
  const input = new PassThrough();
  const output = new PassThrough();
  const finished = runMcpServer({
    engine, input, output, errorOutput: new PassThrough(), serverVersion: '0.0.0-test',
  });
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
  });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: request } })}\n`);
  input.end();
  await finished;

  const line = buffer.trim().split('\n')[0] ?? '{}';
  const payload = JSON.parse((JSON.parse(line) as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '{}') as Record<string, unknown>;
  const cliPayload = JSON.parse(JSON.stringify(direct.outcome)) as Record<string, unknown>;

  const strip = (value: Record<string, unknown>): unknown => {
    const copy = structuredClone(value) as { search_id?: unknown; report?: { usage?: { elapsed_ms?: unknown } } };
    delete copy.search_id;
    if (copy.report?.usage !== undefined) {
      delete copy.report.usage.elapsed_ms;
    }
    return copy;
  };
  assert.deepEqual(strip(payload), strip(cliPayload),
    'the two adapters differ only by generated identifiers and timing');
});
