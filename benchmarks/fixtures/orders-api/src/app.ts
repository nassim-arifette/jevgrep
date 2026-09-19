import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { authenticate } from './middleware/authenticate';
import { rateLimit } from './middleware/rate-limit';
import type { AppConfig } from './lib/config';
import { logger } from './lib/logger';
import { registerRoutes } from './routes';

export type AppDependencies = {
  readonly config: AppConfig;
  readonly pool: Pool;
};

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  app.use(express.json({ limit: dependencies.config.http.bodyLimitBytes }));
  app.use(rateLimit({ windowMs: 60_000, maxRequests: 120 }));
  app.use(authenticate);

  // Every API router is mounted here; the order matters because the error handler
  // must stay last.
  registerRoutes(app, dependencies);

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error({ error }, 'unhandled request error');
    response.status(500).json({ error: 'internal_error' });
  });

  return app;
}
