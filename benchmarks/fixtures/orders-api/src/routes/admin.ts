import { Router } from 'express';
import { requireRole } from '../middleware/authenticate';
import type { AppDependencies } from '../app';
import { PricingService } from '../services/pricing';

export function createAdminRouter(dependencies: AppDependencies): Router {
  const router = Router();
  const pricing = new PricingService(dependencies.config);

  router.get('/discounts', requireRole('admin'), (_request, response) => {
    response.json({ maxPercent: dependencies.config.orders.maxDiscountPercent });
  });

  router.post('/discounts/preview', requireRole('admin'), (request, response) => {
    const preview = pricing.previewDiscount({
      subtotalCents: Number(request.body?.subtotalCents ?? 0),
      discountPercent: Number(request.body?.discountPercent ?? 0),
      customerTier: String(request.body?.customerTier ?? 'standard'),
    });
    response.json(preview);
  });

  return router;
}
