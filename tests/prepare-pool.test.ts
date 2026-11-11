import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { MessagePort, WorkerOptions } from 'node:worker_threads';

import { PreparePool, countTokensWithAsync } from '../src/source/prepare-pool.ts';
import { AuthorizedRoot } from '../src/source/authorization.ts';
import { prepareScopeCooperatively } from '../src/source/prepare.ts';
import { offlineEnv, sourceEntry } from './helpers/cli-runner.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/** Worker failures and stalls are injected through the Node builtin, without changing the production protocol. */
class ControlledWorker extends EventEmitter {
  static instances: ControlledWorker[] = [];
  readonly port: MessagePort;
  readonly jobs: { ticket: number }[] = [];
  referenced = false;
  terminated = false;

  constructor(_url: URL, options: WorkerOptions) {
    super();
    this.port = (options.workerData as { port: MessagePort }).port;
    ControlledWorker.instances.push(this);
  }

  ref(): void { this.referenced = true; }
  unref(): void { this.referenced = false; }
  postMessage(job: { ticket: number }): void {
    assert.equal(this.terminated, false, 'terminated workers must never receive another job');
    this.jobs.push(job);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    this.port.close();
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

function controlWorkers(t: TestContext): void {
  const threads = createRequire(import.meta.url)('node:worker_threads') as { Worker: unknown };
  const original = threads.Worker;
  ControlledWorker.instances = [];
  threads.Worker = ControlledWorker;
  syncBuiltinESMExports();
  t.after(() => { threads.Worker = original; syncBuiltinESMExports(); });
}

test('a failed worker settles its jobs, and only healthy workers accept more work', async (t) => {
  controlWorkers(t);
  const pool = new PreparePool(2, 'async');
  t.after(() => pool.close());
  const first = pool.submitCount(['first']);
  const second = pool.submitCount(['second']);
  const [failed, healthy] = ControlledWorker.instances;
  assert.ok(failed !== undefined && healthy !== undefined);
  assert.equal(failed.referenced, true);
  failed.emit('error', new Error('synthetic failure'));
  assert.deepEqual(await pool.wait(first), { failed: true });
  assert.equal(pool.size, 1);
  const third = pool.submitCount(['third']);
  assert.equal(failed.jobs.length, 1);
  assert.equal(healthy.jobs.length, 2);
  healthy.port.postMessage({ ticket: second, counts: [2] });
  assert.deepEqual(await pool.wait(second), { counts: [2] });
  assert.equal(healthy.referenced, true, 'a second pending job still keeps the process alive');
  healthy.port.postMessage({ ticket: third, counts: [3] });
  assert.deepEqual(await pool.wait(third), { counts: [3] });
  assert.equal(healthy.referenced, false, 'the shared worker becomes idle after its final reply');
});

test('an asynchronous worker that makes no progress times out and future work falls back immediately', async (t) => {
  controlWorkers(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = new PreparePool(1, 'async');
  t.after(() => pool.close());
  const first = pool.wait(pool.submitCount(['first']));
  const second = pool.wait(pool.submitCount(['second']));
  t.mock.timers.tick(120_000);
  assert.deepEqual(await first, { failed: true });
  assert.deepEqual(await second, { failed: true });
  assert.equal(pool.size, 0);
  assert.equal(ControlledWorker.instances[0]!.terminated, true);
  assert.deepEqual(await pool.wait(pool.submitCount(['after failure'])), { failed: true });
  assert.deepEqual(await countTokensWithAsync(pool, ['one', 'two'], (text) => text.length), [3, 3]);
});

test('closing a pool resolves pending waits and refuses subsequent jobs', async (t) => {
  controlWorkers(t);
  const pool = new PreparePool(1, 'async');
  const pending = pool.wait(pool.submitCount(['pending']));
  pool.close();
  assert.deepEqual(await pending, { failed: true });
  assert.deepEqual(await pool.wait(pool.submitCount(['closed'])), { failed: true });
});

test('cancelling a worker wait discards its result and stops an abandoned worker', async (t) => {
  controlWorkers(t);
  const pool = new PreparePool(1, 'async');
  t.after(() => pool.close());
  const controller = new AbortController();
  const pending = pool.wait(pool.submitCount(['pending']), controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { failed: true });
  assert.equal(ControlledWorker.instances[0]!.terminated, true);
});

test('cancelling preparation during a hung worker wait returns incomplete coverage without local fallback work', async (t) => {
  controlWorkers(t);
  const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' } });
  t.after(() => space.cleanup());
  const controller = new AbortController();
  const preparing = prepareScopeCooperatively(AuthorizedRoot.open(space.repositoryRoot), ['.'], {
    inventory: { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: [] },
    threads: 1,
    signal: controller.signal,
  });
  assert.equal(ControlledWorker.instances.length, 1);
  controller.abort();
  const prepared = await preparing;
  assert.equal(prepared.complete, false);
  assert.equal(prepared.files.length, 0);
  assert.equal(ControlledWorker.instances[0]!.terminated, true, 'read-ahead jobs are abandoned as well');
});

test('a real CLI search above the worker threshold keeps the process alive until it prints a result', { timeout: 60_000 }, async (t) => {
  const source = 'This harmless source line exercises background preparation.\n'.repeat(10_500);
  const space = createWorkspace({ files: { 'a.txt': source, 'b.txt': source }, configure: withRemoteEnabled });
  t.after(() => space.cleanup());
  const preload = join(space.root, 'provider.mjs');
  writeFileSync(preload, `globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: request.model,
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0 }])),
      usage: { input_tokens: 100, output_tokens: 0 } }));
  };\n`);
  const env = { ...offlineEnv(), ...space.env, JEVGREP_PREPARE_THREADS: '1', [space.loaded.config.provider.api_key_env]: 'synthetic-offline-key' };
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, sourceEntry, 'search', '--config', space.configPath,
    '--query', 'background preparation', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout) as { report: { scope_fully_scanned: boolean }; status: string };
  assert.equal(result.report.scope_fully_scanned, true, stdout);
  assert.equal(result.status, 'complete');
  assert.doesNotMatch(stderr, /unsettled top-level await/);
});
