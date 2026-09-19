import { Router } from 'express';
import { requireRole } from '../middleware/authenticate';
import type { AppDependencies } from '../app';
import { OrderService } from '../services/order-service';
import { formatMoney } from '../utils/format';

export function createOrdersRouter(dependencies: AppDependencies): Router {
  const router = Router();
  const orders = new OrderService(dependencies.pool, dependencies.config);

  router.get('/', async (request, response) => {
    const customerId = request.session?.userId ?? '';
    const result = await orders.listOrdersForCustomer(customerId);
    response.json({
      items: result.map((order) => ({
        id: order.id,
        status: order.status,
        total: formatMoney(order.totalCents, order.currency),
      })),
    });
  });

  router.post('/:orderId/cancel', requireRole('agent'), async (request, response) => {
    const outcome = await orders.cancelOrder({
      orderId: request.params.orderId,
      actorId: request.session?.userId ?? '',
      reason: String(request.body?.reason ?? 'customer_request'),
    });

    if (!outcome.cancelled) {
      response.status(409).json({ error: outcome.reason });
      return;
    }
    response.json({ status: 'cancelled', refunded: outcome.refunded });
  });

  return router;
}
