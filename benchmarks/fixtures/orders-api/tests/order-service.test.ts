import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderService } from '../src/services/order-service';
import { fakePool } from './helpers/fake-db';
import { loadConfig } from '../src/lib/config';

const config = loadConfig({ environment: 'test', configDir: 'config' });

test('a paid order is refunded when it is cancelled inside the window', async () => {
  const pool = fakePool({ orders: [{ id: 'o-1', status: 'paid', placedAt: new Date() }] });
  const service = new OrderService(pool, config);

  const outcome = await service.cancelOrder({ orderId: 'o-1', actorId: 'a-1', reason: 'customer_request' });

  assert.deepEqual(outcome, { cancelled: true, refunded: true });
});

test('a cancelled order cannot be cancelled twice', async () => {
  const pool = fakePool({ orders: [{ id: 'o-2', status: 'cancelled', placedAt: new Date() }] });
  const service = new OrderService(pool, config);

  const outcome = await service.cancelOrder({ orderId: 'o-2', actorId: 'a-1', reason: 'customer_request' });

  assert.deepEqual(outcome, { cancelled: false, reason: 'already_cancelled' });
});

test('the cancel window closes after the configured number of hours', async () => {
  const placedAt = new Date(Date.now() - 72 * 3_600_000);
  const pool = fakePool({ orders: [{ id: 'o-3', status: 'paid', placedAt }] });
  const service = new OrderService(pool, config);

  const outcome = await service.cancelOrder({ orderId: 'o-3', actorId: 'a-1', reason: 'customer_request' });

  assert.deepEqual(outcome, { cancelled: false, reason: 'window_closed' });
});
