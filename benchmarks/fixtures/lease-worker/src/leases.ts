export type Lease = {
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: number;
};

export interface LeaseStore {
  read(jobId: string): Promise<Lease | undefined>;
  compareAndSwap(jobId: string, expected: Lease | undefined, next: Lease): Promise<boolean>;
  complete(jobId: string, owner: string, generation: number): Promise<boolean>;
}

export async function acquireLease(
  store: LeaseStore,
  jobId: string,
  owner: string,
  now: number,
  leaseMs: number,
): Promise<Lease | undefined> {
  const previous = await store.read(jobId);
  if (previous !== undefined && previous.expiresAt > now) return undefined;
  const next = { owner, generation: (previous?.generation ?? 0) + 1, expiresAt: now + leaseMs };
  return await store.compareAndSwap(jobId, previous, next) ? next : undefined;
}

export async function finishLease(store: LeaseStore, jobId: string, lease: Lease): Promise<boolean> {
  return store.complete(jobId, lease.owner, lease.generation);
}
