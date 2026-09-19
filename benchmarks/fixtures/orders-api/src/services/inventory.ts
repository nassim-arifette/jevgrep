import type { Pool } from 'pg';

export type Reservation = { readonly sku: string; readonly quantity: number };

export class InventoryService {
  constructor(private readonly pool: Pool) {}

  async reserve(orderId: string, items: readonly Reservation[], ttlSeconds: number): Promise<void> {
    for (const item of items) {
      await this.pool.query(
        `insert into reservations (order_id, sku, quantity, expires_at)
         values ($1, $2, $3, now() + ($4 || ' seconds')::interval)
         on conflict (order_id, sku) do update set quantity = excluded.quantity`,
        [orderId, item.sku, item.quantity, String(ttlSeconds)],
      );
    }
  }

  async release(orderId: string): Promise<void> {
    await this.pool.query('delete from reservations where order_id = $1', [orderId]);
  }
}
