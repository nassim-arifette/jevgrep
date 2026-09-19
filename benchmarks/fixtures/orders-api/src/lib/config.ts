import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppConfig = {
  readonly environment: string;
  readonly http: { readonly port: number; readonly bodyLimitBytes: number; readonly requestTimeoutMs: number };
  readonly orders: {
    readonly maxLineItems: number;
    readonly maxDiscountPercent: number;
    readonly cancelWindowHours: number;
    readonly reservationTtlSeconds: number;
  };
  readonly database: { readonly poolSize: number; readonly statementTimeoutMs: number };
  readonly logging: { readonly level: string };
};

type RawConfig = {
  http: { port: number; body_limit_bytes: number; request_timeout_ms: number };
  orders: {
    max_line_items: number;
    max_discount_percent: number;
    cancel_window_hours: number;
    reservation_ttl_seconds: number;
  };
  database: { pool_size: number; statement_timeout_ms: number };
  logging: { level: string };
};

function readJson(path: string): Partial<RawConfig> {
  return JSON.parse(readFileSync(path, 'utf8')) as Partial<RawConfig>;
}

/**
 * Configuration is layered: the default file, then the environment file, then an
 * explicit override file. Environment variables are validated at the same place.
 */
export function loadConfig(options: { environment: string; configDir?: string; overridePath?: string }): AppConfig {
  const configDir = options.configDir ?? join(process.cwd(), 'config');
  const defaults = readJson(join(configDir, 'default.json'));
  const environment = readJson(join(configDir, `${options.environment}.json`));
  const override = options.overridePath === undefined ? {} : readJson(options.overridePath);

  const merged: RawConfig = {
    http: { ...defaults.http, ...environment.http, ...override.http },
    orders: { ...defaults.orders, ...environment.orders, ...override.orders },
    database: { ...defaults.database, ...environment.database, ...override.database },
    logging: { ...defaults.logging, ...environment.logging, ...override.logging },
  } as RawConfig;

  return {
    environment: options.environment,
    http: {
      port: Number(process.env.PORT ?? merged.http.port),
      bodyLimitBytes: merged.http.body_limit_bytes,
      requestTimeoutMs: merged.http.request_timeout_ms,
    },
    orders: {
      maxLineItems: merged.orders.max_line_items,
      maxDiscountPercent: Number(process.env.MAX_DISCOUNT_PERCENT ?? merged.orders.max_discount_percent),
      cancelWindowHours: merged.orders.cancel_window_hours,
      reservationTtlSeconds: merged.orders.reservation_ttl_seconds,
    },
    database: {
      poolSize: merged.database.pool_size,
      statementTimeoutMs: merged.database.statement_timeout_ms,
    },
    logging: { level: process.env.LOG_LEVEL ?? merged.logging.level },
  };
}
