import type { OutboxStore, PendingDelivery } from './outbox';

export interface Database {
  all<T>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]>;
  run(sql: string, parameters: readonly unknown[]): Promise<void>;
}

export function sqlOutbox(db: Database): OutboxStore {
  return {
    due(now: number) {
      return db.all<PendingDelivery>(
        'SELECT id, body, attempts FROM outbox WHERE delivered_at IS NULL AND next_at <= ? ORDER BY next_at, id',
        [now],
      );
    },
    delivered(id: string) {
      return db.run('UPDATE outbox SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    },
    failed(id: string, attempts: number, nextAt: number | null) {
      return db.run('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?', [attempts, nextAt, id]);
    },
  };
}
