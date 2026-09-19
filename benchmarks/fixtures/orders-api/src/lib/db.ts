import { Pool } from 'pg';

export type PoolOptions = {
  readonly connectionString: string;
  readonly poolSize: number;
  readonly statementTimeoutMs: number;
};

export function createPool(options: PoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.poolSize,
    statement_timeout: options.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
}

export async function withTransaction<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
