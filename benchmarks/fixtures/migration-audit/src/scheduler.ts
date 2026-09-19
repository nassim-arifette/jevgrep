import { runRetention, type RetentionConfig } from './job.ts';
import type { AuditRepository } from './repository.ts';

export type Scheduler = { schedule(expression: string, task: () => Promise<void>): void };

export function registerRetentionJob(
  scheduler: Scheduler,
  repository: AuditRepository,
  config: RetentionConfig,
): void {
  scheduler.schedule('0 3 * * *', async () => {
    await runRetention(repository, new Date(), config);
  });
}
