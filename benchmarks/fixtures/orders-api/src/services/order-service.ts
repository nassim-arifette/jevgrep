import type { Pool } from 'pg';
import type { AppConfig } from '../lib/config';
import { logger } from '../lib/logger';

export type Order = {
  readonly id: string;
  readonly status: 'pending' | 'paid' | 'shipped' | 'cancelled';
  readonly totalCents: number;
  readonly currency: string;
  readonly placedAt: Date;
};

export type CancelRequest = {
  readonly orderId: string;
  readonly actorId: string;
  readonly reason: string;
};

export type CancelOutcome =
  | { readonly cancelled: true; readonly refunded: boolean }
  | { readonly cancelled: false; readonly reason: 'not_found' | 'already_cancelled' | 'window_closed' };

export class OrderService {
  constructor(private readonly pool: Pool, private readonly config: AppConfig) {}

  async listOrdersForCustomer(customerId: string): Promise<readonly Order[]> {
    const result = await this.pool.query<Order>(
      `select id, status, total_cents as "totalCents", currency, placed_at as "placedAt"
         from orders
        where customer_id = $1
        order by placed_at desc
        limit 100`,
      [customerId],
    );
    return result.rows;
  }

  async cancelOrder(request: CancelRequest): Promise<CancelOutcome> {
    const order = await this.loadOrder(request.orderId);

    if (order === undefined) {
      return { cancelled: false, reason: 'not_found' };
    }
    if (order.status === 'cancelled') {
      return { cancelled: false, reason: 'already_cancelled' };
    }
    if (this.isOutsideCancelWindow(order.placedAt)) {
      return { cancelled: false, reason: 'window_closed' };
    }

    await this.pool.query('update orders set status = $2 where id = $1', [order.id, 'cancelled']);
    logger.info({ orderId: order.id, actorId: request.actorId, reason: request.reason }, 'order cancelled');

    return { cancelled: true, refunded: order.status === 'paid' };
  }

  private async loadOrder(orderId: string): Promise<Order | undefined> {
    const result = await this.pool.query<Order>(
      'select id, status, total_cents as "totalCents", currency, placed_at as "placedAt" from orders where id = $1',
      [orderId],
    );
    return result.rows[0];
  }

  private isOutsideCancelWindow(placedAt: Date): boolean {
    const elapsedMs = Date.now() - placedAt.getTime();
    return elapsedMs > this.config.orders.cancelWindowHours * 3_600_000;
  }
}
