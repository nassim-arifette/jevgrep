/** Summaries keep the planned denominator: a missing or failed row is never silently dropped. */
export type PlannedRow<M> = { readonly id: string; readonly metrics: M | null; readonly error?: string | null };

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/** p95 needs enough observations to be more than the maximum. */
export const minimumP95Samples = 20;

export function latencySummary(values: readonly number[]) {
  return {
    n: values.length, median: quantile(values, 0.5),
    p95: values.length >= minimumP95Samples ? quantile(values, 0.95) : null,
    p95Note: values.length >= minimumP95Samples ? null : `insufficient samples (${values.length} < ${minimumP95Samples})`,
  };
}

export function plannedSummary<M>(planned: readonly string[], rows: readonly PlannedRow<M>[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = planned.filter((id) => !byId.has(id));
  const unplanned = rows.filter((row) => !planned.includes(row.id)).map((row) => row.id);
  if (unplanned.length > 0) throw new Error(`rows outside the planned set: ${unplanned.join(', ')}`);
  const complete = rows.filter((row) => row.metrics !== null).length;
  return {
    planned: planned.length, complete, incomplete: rows.length - complete, notRun: missing.length,
    completionRate: planned.length === 0 ? null : complete / planned.length, missing,
  };
}

/** Group rows by a key; each group keeps its own planned denominator. */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return new Map([...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
