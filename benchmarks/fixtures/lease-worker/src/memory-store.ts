import type { Lease, LeaseStore } from './leases';

export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();
  readonly completed = new Set<string>();

  async read(jobId: string): Promise<Lease | undefined> {
    return this.leases.get(jobId);
  }

  async compareAndSwap(jobId: string, expected: Lease | undefined, next: Lease): Promise<boolean> {
    if (this.completed.has(jobId) || this.leases.get(jobId) !== expected) return false;
    this.leases.set(jobId, next);
    return true;
  }

  async complete(jobId: string, owner: string, generation: number): Promise<boolean> {
    const current = this.leases.get(jobId);
    if (current?.owner !== owner || current.generation !== generation) return false;
    this.leases.delete(jobId);
    this.completed.add(jobId);
    return true;
  }
}
