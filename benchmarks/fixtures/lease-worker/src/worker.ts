import { acquireLease, finishLease } from './leases';
import type { LeaseStore } from './leases';

export interface Job {
  readonly id: string;
  run(): Promise<void>;
}

export async function runJob(store: LeaseStore, job: Job, worker: string, now: number): Promise<string> {
  const lease = await acquireLease(store, job.id, worker, now, 30_000);
  if (lease === undefined) return 'busy';
  await job.run();
  return await finishLease(store, job.id, lease) ? 'completed' : 'stale';
}
