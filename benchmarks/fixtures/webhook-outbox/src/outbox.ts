export type PendingDelivery = {
  readonly id: string;
  readonly body: string;
  readonly attempts: number;
};

export interface OutboxStore {
  due(now: number): Promise<readonly PendingDelivery[]>;
  delivered(id: string): Promise<void>;
  failed(id: string, attempts: number, nextAt: number | null): Promise<void>;
}

export interface Sender {
  post(body: string, headers: Readonly<Record<string, string>>): Promise<{ status: number }>;
}

export async function deliverDue(store: OutboxStore, sender: Sender, now: number): Promise<void> {
  for (const item of await store.due(now)) {
    let success = false;
    try {
      const response = await sender.post(item.body, { 'Idempotency-Key': item.id });
      success = response.status >= 200 && response.status < 300;
    } catch {
      success = false;
    }
    if (success) {
      await store.delivered(item.id);
      continue;
    }
    const attempts = item.attempts + 1;
    const delay = Math.min(60_000, 1_000 * 2 ** (attempts - 1));
    const nextAt = attempts >= 5 ? null : now + delay;
    await store.failed(item.id, attempts, nextAt);
  }
}
