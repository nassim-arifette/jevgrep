import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { prepareEntry } from './prepare.ts';
import type { WindowLimits } from './chunker.ts';

type Job = {
  readonly ticket: number; readonly relativePath: string; readonly absolutePath: string;
  readonly bytes: ArrayBuffer; readonly sha256: string; readonly windowLimits: WindowLimits;
};

const { port, counter } = workerData as { port: MessagePort; counter: SharedArrayBuffer };
const done = new Int32Array(counter);
if (parentPort === null) throw new Error('prepare worker requires a worker thread');

parentPort.on('message', (job: Job) => {
  let reply: { ticket: number; entry?: unknown; failed?: true };
  try {
    reply = { ticket: job.ticket, entry: prepareEntry(job.relativePath, job.absolutePath, Buffer.from(job.bytes), job.sha256, job.windowLimits) };
  } catch {
    reply = { ticket: job.ticket, failed: true };
  }
  port.postMessage(reply);
  Atomics.add(done, 0, 1);
  Atomics.notify(done, 0);
});
