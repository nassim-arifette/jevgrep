import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

// Exercise the real worker protocol with a controllable child process and clock.
// No PowerShell launch, host load, or wall-clock sleep is needed for these cases.
const harness = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');
const { mock } = require('node:test');
const child = new EventEmitter();
const port = new EventEmitter();
port.close = () => {};
require('node:worker_threads').parentPort = port;
child.stdin = new PassThrough();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
child.kill = () => true;
child.stdin.on('data', () => parentPort.postMessage('request'));
let launch;
require('node:child_process').spawn = (executable, args, options) => {
  launch = { executable, args, options };
  return child;
};
syncBuiltinESMExports();
mock.timers.enable({ apis: ['setTimeout'] });
import(workerData).then(() => {
  parentPort.on('message', message => {
    if (message.launch) parentPort.postMessage(launch);
    if (message.state !== undefined) port.emit('message', message);
    if (message.tick !== undefined) {
      mock.timers.tick(message.tick);
      parentPort.postMessage('ticked');
    }
    if (message.reply !== undefined) child.stdout.write(message.reply);
  });
  parentPort.postMessage('ready');
});
`;

test('the helper uses an explicit system module path without inheriting secrets or user modules', async (t) => {
  const worker = new Worker(harness, {
    eval: true, workerData: new URL('../src/source/windows-attributes-worker.ts', import.meta.url).href,
    env: { SystemRoot: 'C:\\Windows', PSModulePath: 'UNTRUSTED_MODULES', SYNTHETIC_API_KEY: 'do-not-forward' },
  });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  worker.postMessage({ launch: true });
  const [launch] = await once(worker, 'message') as [{ options: { env: Record<string, string> }; args: string[] }];
  assert.deepEqual(Object.keys(launch.options.env).sort(), ['PSModulePath', 'SystemRoot', 'WINDIR']);
  const modules = join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  assert.equal(launch.options.env['PSModulePath'], `${join(modules, 'Microsoft.PowerShell.Utility')};${modules}`);
  assert.ok(!JSON.stringify(launch).includes('UNTRUSTED_MODULES'));
  assert.ok(!JSON.stringify(launch).includes('do-not-forward'));
  assert.ok(launch.args.includes('-NoProfile'));
});

test('cold PowerShell startup has a separate bounded allowance; warm requests still time out', async (t) => {
  const worker = new Worker(harness, {
    eval: true, workerData: new URL('../src/source/windows-attributes-worker.ts', import.meta.url).href,
  });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  const first = new Int32Array(new SharedArrayBuffer(8));
  worker.postMessage({ paths: ['C:\\'], state: first.buffer });
  assert.deepEqual(await once(worker, 'message'), ['request']);
  // The CI failure: initialization takes longer than the normal request budget.
  worker.postMessage({ tick: 8_500 });
  assert.deepEqual(await once(worker, 'message'), ['ticked']);
  assert.equal(Atomics.load(first, 0), 0, 'cold startup must not expire after 8 seconds');
  worker.postMessage({ reply: '1 -1\n' });
  // A fast reply may arrive before the waiter is registered ("not-equal").
  assert.notEqual(await Atomics.waitAsync(first, 0, 0, 2_000).value, 'timed-out');
  assert.equal(Atomics.load(first, 0), 1);
  const next = new Int32Array(new SharedArrayBuffer(8));
  worker.postMessage({ paths: ['C:\\'], state: next.buffer });
  assert.deepEqual(await once(worker, 'message'), ['request']);
  worker.postMessage({ tick: 8_000 });
  assert.deepEqual(await once(worker, 'message'), ['ticked']);
  assert.equal(Atomics.load(next, 0), 5, 'a hung warm request must still fail closed');
});

test('a PowerShell helper that never starts still times out and refuses access', async (t) => {
  const worker = new Worker(harness, {
    eval: true, workerData: new URL('../src/source/windows-attributes-worker.ts', import.meta.url).href,
  });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  const state = new Int32Array(new SharedArrayBuffer(8));
  worker.postMessage({ paths: ['C:\\'], state: state.buffer });
  assert.deepEqual(await once(worker, 'message'), ['request']);
  worker.postMessage({ tick: 30_000 });
  assert.deepEqual(await once(worker, 'message'), ['ticked']);
  assert.equal(Atomics.load(state, 0), 5);
  assert.equal(Atomics.load(state, 1), -1);
});
