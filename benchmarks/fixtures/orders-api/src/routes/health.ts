import { Router } from 'express';
import type { AppDependencies } from '../app';

export function createHealthRouter(_dependencies: AppDependencies): Router {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json({ status: 'ok' });
  });

  router.get('/ready', async (_request, response) => {
    response.json({ status: 'ready', checks: ['database'] });
  });

  return router;
}
