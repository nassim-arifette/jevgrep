import { Worker } from 'node:worker_threads';
import { ATTRIBUTE_REQUEST_TIMEOUT_MS, ATTRIBUTE_STARTUP_TIMEOUT_MS, ATTRIBUTE_WORKER_GRACE_MS } from './windows-attributes-timeouts.ts';

/** Windows attributes unavailable through Node Stats; paths are always data. */
export class AttributeCheckError extends Error {
  override readonly name = 'AttributeCheckError';
  readonly kind: 'link' | 'missing' | 'unavailable';
  readonly path: string | undefined;

  constructor(kind: AttributeCheckError['kind'], path?: string) {
    super(`Windows attribute check refused the path: ${kind}`);
    this.kind = kind;
    this.path = path;
  }
}

let worker: Worker | undefined;
let unavailable = false;

/**
 * One persistent helper, bounded requests, and no cached authorization decisions.
 * A worker services its pipes so a hung helper cannot block this reader indefinitely.
 * Each array must be ordered from the volume root towards the requested leaf.
 */
export function assertNoReparsePoints(paths: readonly string[]): void {
  if (process.platform !== 'win32') return;
  if (unavailable || paths.length === 0 || paths.length > 512
    || Buffer.byteLength(JSON.stringify(paths)) > 1_048_576) {
    throw new AttributeCheckError('unavailable');
  }
  const starting = worker === undefined;
  if (worker === undefined) {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    worker = new Worker(new URL(`./windows-attributes-worker.${extension}`, import.meta.url), {
      execArgv: [], stdout: true, stderr: true,
    });
    worker.on('error', () => { unavailable = true; });
    worker.on('exit', () => { unavailable = true; });
    // No helper diagnostics or source paths escape into the CLI/MCP streams.
    // The worker never writes these streams. Leaving them unconsumed avoids a
    // stdio MessagePort reference keeping a short-lived CLI process alive.
    worker.unref();
  }
  // Status plus offending component index; paths never appear in helper output.
  const state = new Int32Array(new SharedArrayBuffer(8));
  worker.postMessage({ paths, state: state.buffer });
  const timeout = starting ? ATTRIBUTE_STARTUP_TIMEOUT_MS : ATTRIBUTE_REQUEST_TIMEOUT_MS;
  const waited = Atomics.wait(state, 0, 0, timeout + ATTRIBUTE_WORKER_GRACE_MS);
  const status = Atomics.load(state, 0);
  const index = Atomics.load(state, 1);
  const refusedPath = index >= 0 && index < paths.length ? paths[index] : undefined;
  if (waited === 'timed-out' || status === 5 || status === 0) {
    unavailable = true;
    // The worker also has a shorter watchdog which kills its own child and pipes.
    worker.postMessage({ close: true });
    throw new AttributeCheckError('unavailable');
  }
  if (status === 2) throw new AttributeCheckError('link', refusedPath);
  if (status === 3) throw new AttributeCheckError('missing', refusedPath);
  // Status 4 is local to this path (permissions, length, unsupported entry), not
  // a broken helper: a subsequent valid request must still be serviceable.
  if (status !== 1) throw new AttributeCheckError('unavailable', refusedPath);
}
