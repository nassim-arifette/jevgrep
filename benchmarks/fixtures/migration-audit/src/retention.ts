export type AuditEvent = {
  readonly id: string;
  readonly createdAt: Date;
  readonly legalHold: boolean;
};

export function expired(events: readonly AuditEvent[], now: Date, retentionDays: number): readonly string[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => !event.legalHold && event.createdAt.getTime() < cutoff)
    .map((event) => event.id)
    .sort();
}

export function batches(ids: readonly string[], size: number): readonly (readonly string[])[] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('batch size must be positive');
  }
  const result: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    result.push(ids.slice(offset, offset + size));
  }
  return result;
}
