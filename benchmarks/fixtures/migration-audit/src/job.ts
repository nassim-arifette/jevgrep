import { deleteBatch, type AuditRepository } from './repository.ts';
import { batches, expired } from './retention.ts';

export type RetentionConfig = { readonly auditDays: number; readonly deleteBatchSize: number };

export async function runRetention(
  repository: AuditRepository,
  now: Date,
  config: RetentionConfig,
): Promise<number> {
  const cutoff = new Date(now.getTime() - config.auditDays * 24 * 60 * 60 * 1000);
  const candidates = await repository.findBefore(cutoff);
  const groups = batches(expired(candidates, now, config.auditDays), config.deleteBatchSize);
  let deleted = 0;
  for (const ids of groups) {
    deleted += await deleteBatch(repository, ids);
  }
  return deleted;
}
