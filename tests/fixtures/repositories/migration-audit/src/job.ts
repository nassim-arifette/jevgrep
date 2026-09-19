import { batches, expired, type AuditEvent } from './retention.ts';

export function planDeletion(events: readonly AuditEvent[], now: Date): readonly (readonly string[])[] {
  return batches(expired(events, now, 90), 100);
}
