import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, test } from 'node:test';

import type { SearchEngine } from '../src/engine.ts';
import { MAX_MESSAGE_LENGTH, runMcpServer } from '../src/mcp.ts';
import { AuthorizedRoot } from '../src/source/authorization.ts';
import { prepareScope, prepareScopeCooperatively } from '../src/source/prepare.ts';

/**
 * Roadmap section 5: local CPU work must not keep the stdio server from reading a
 * cancellation, input must be bounded before parsing, and unread or broken output
 * must stop the server instead of buffering without bound.
 */
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(files: number): string {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-responsive-'));
  roots.push(root);
  for (let n = 0; n < files; n += 1) {
    const directory = join(root, 'src', `d${String(n % 10)}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `f${String(n)}.ts`), `export function f${String(n)}(): number {\n  return ${String(n)};\n}\n`);
  }
  return root;
}

const inventory = { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: [] };

test('cooperative preparation returns exactly what synchronous preparation returns', async () => {
  const root = repository(40);
  const strip = (prepared: ReturnType<typeof prepareScope>): unknown => ({
    complete: prepared.complete,
    files: prepared.files.map((file) => file.snapshot.relativePath),
    fragments: prepared.fragments.map((fragment) => [fragment.id, fragment.text]),
  });
  const sync = prepareScope(AuthorizedRoot.open(root), ['.'], { inventory });
  const cooperative = await prepareScopeCooperatively(AuthorizedRoot.open(root), ['.'], { inventory }, 0);
  assert.deepEqual(strip(cooperative), strip(sync));
  assert.equal(cooperative.complete, true);
});

test('cooperative preparation on the worker pool returns what synchronous preparation returns and keeps the event loop live', async () => {
  const root = repository(200);
  const strip = (prepared: ReturnType<typeof prepareScope>): unknown => ({
    complete: prepared.complete,
    fragments: prepared.fragments.map((fragment) => [fragment.id, fragment.text, fragment.tokenCount, fragment.declaration ?? null]),
  });
  const sync = prepareScope(AuthorizedRoot.open(root), ['.'], { inventory, threads: 0 });
  let ticks = 0;
  let running = true;
  const tick = (): void => { if (running) { ticks += 1; setImmediate(tick); } };
  setImmediate(tick);
  const cooperative = await prepareScopeCooperatively(AuthorizedRoot.open(root), ['.'], { inventory, threads: 2 }, 0);
  running = false;
  assert.deepEqual(strip(cooperative), strip(sync));
  assert.ok(ticks > 10, `the event loop ran ${String(ticks)} times while the pool prepared 200 files`);
});

test('a stop requested from the event loop interrupts cooperative preparation on the worker pool', async () => {
  const root = repository(200);
  let stop = false;
  setImmediate(() => { stop = true; });
  const prepared = await prepareScopeCooperatively(AuthorizedRoot.open(root), ['.'], { inventory, threads: 2, shouldStop: () => stop }, 0);
  assert.equal(prepared.complete, false);
  assert.ok(prepared.files.length < 200);
});

test('a stop requested from the event loop interrupts cooperative inventory and preparation', async () => {
  const root = repository(200);
  for (const stage of ['inventory', 'preparation'] as const) {
    let stop = false;
    setImmediate(() => {
      stop = true;
    });
    const shouldStop = (): boolean => stop;
    const prepared = await prepareScopeCooperatively(AuthorizedRoot.open(root), ['.'], {
      inventory: stage === 'inventory' ? { ...inventory, shouldStop } : inventory,
      shouldStop,
    }, 0);
    assert.equal(prepared.complete, false, stage);
    assert.ok(prepared.files.length < 200, stage);
  }
});

function idleEngine(): SearchEngine {
  return { clock: { nowMs: 0 } } as unknown as SearchEngine;
}

async function serve(chunks: readonly string[], output: Writable = new PassThrough()): Promise<{ lines: string[]; log: string }> {
  const input = new PassThrough();
  const errorOutput = new PassThrough();
  let log = '';
  errorOutput.setEncoding('utf8');
  errorOutput.on('data', (chunk: string) => {
    log += chunk;
  });
  const lines: string[] = [];
  if (output instanceof PassThrough) {
    let buffer = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      lines.push(...parts);
    });
  }
  const finished = runMcpServer({ engine: idleEngine(), input, output, errorOutput, serverVersion: '0.0.0-test' });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  return { lines, log };
}

test('a line that never ends is discarded once it passes the limit, and the next message is answered', async () => {
  const half = 'x'.repeat(MAX_MESSAGE_LENGTH / 2 + 1);
  const { lines, log } = await serve([`{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${half}`, half, half, '"}\n',
    '{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);
  const messages = lines.map((line) => JSON.parse(line) as { id: unknown; error?: { message: string } });
  assert.deepEqual(messages.map((message) => message.id), [null, 2]);
  assert.equal(messages[0]?.error?.message, 'message too large');
  assert.match(log, /oversized message/);
  assert.ok(!log.includes('xxxx'), 'input is never echoed');
});

test('a complete line over the limit is refused before parsing', async () => {
  const { lines } = await serve([`{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${'x'.repeat(MAX_MESSAGE_LENGTH)}"}\n`,
    '{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { id: unknown }).id), [null, 2]);
});

test('a broken output stream stops the server instead of hanging', async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback): void {
      callback(new Error('EPIPE'));
    },
  });
  const { log } = await serve(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'], output);
  assert.match(log, /output stream failed/);
});

test('output the client never reads is bounded', async () => {
  const output = new Writable({
    highWaterMark: 1024,
    write(): void {
      // Never acknowledges a write, like a client that stopped reading.
    },
  });
  const requests = Array.from({ length: 30_000 }, (_, n) => `{"jsonrpc":"2.0","id":${String(n)},"method":"tools/list"}\n`);
  const { log } = await serve([requests.join('')], output);
  assert.match(log, /output is not being read/);
  assert.ok(output.writableLength < 2 * 16_777_216);
});
