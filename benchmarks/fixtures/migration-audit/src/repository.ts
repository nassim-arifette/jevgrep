import type { AuditEvent } from './retention.ts';

export type AuditRepository = {
  findBefore(cutoff: Date): Promise<readonly AuditEvent[]>;
  deleteByIds(ids: readonly string[]): Promise<number>;
};

export async function deleteBatch(repository: AuditRepository, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return repository.deleteByIds(ids);
}
