import type { Express } from 'express';
import type { AppDependencies } from '../app';
import { createAdminRouter } from './admin';
import { createHealthRouter } from './health';
import { createOrdersRouter } from './orders';

/**
 * Top-level route registration. A search for where an HTTP endpoint is wired in
 * should find this file.
 */
export function registerRoutes(app: Express, dependencies: AppDependencies): void {
  app.use('/health', createHealthRouter(dependencies));
  app.use('/api/v1/orders', createOrdersRouter(dependencies));
  app.use('/api/v1/admin', createAdminRouter(dependencies));
}
