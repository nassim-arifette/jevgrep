import type { Pool, QueryResult } from 'pg';

type Row = { id: string; status: string; placedAt: Date };

/**
 * Minimal in-memory stand-in for the `pg` pool used by the service tests. It
 * understands only the two statements the service issues.
 */
export function fakePool(seed: { orders: readonly Row[] }): Pool {
  const orders = seed.orders.map((row) => ({ ...row }));

  const query = async (text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> => {
    if (text.includes('update orders set status')) {
      const order = orders.find((row) => row.id === values[0]);
      if (order !== undefined) {
        order.status = String(values[1]);
      }
    }
    if (text.includes('where id = $1')) {
      return { rows: orders.filter((row) => row.id === values[0]) } as QueryResult<Row>;
    }
    return { rows: orders } as QueryResult<Row>;
  };

  return { query } as unknown as Pool;
}
