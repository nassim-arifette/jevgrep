import { createApp } from './app';
import { loadConfig } from './lib/config';
import { createPool } from './lib/db';
import { logger } from './lib/logger';

const config = loadConfig({ environment: process.env.NODE_ENV ?? 'development' });
const pool = createPool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost/orders',
  poolSize: config.database.poolSize,
  statementTimeoutMs: config.database.statementTimeoutMs,
});

const app = createApp({ config, pool });

const server = app.listen(config.http.port, () => {
  logger.info({ port: config.http.port, environment: config.environment }, 'orders-api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void pool.end().then(() => {
        process.exit(0);
      });
    });
  });
}
