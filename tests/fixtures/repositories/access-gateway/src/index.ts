import { recordDecision, type AuditRecord } from './audit.ts';
import { explainDenial, mayEnter, type Actor } from './policy.ts';

const records: AuditRecord[] = [];

export function authorize(actor: Actor, route: string, requiredRole: string): string {
  const allowed = mayEnter(actor, requiredRole);
  recordDecision(records, { actorId: actor.id, route, allowed });
  return allowed ? 'allowed' : explainDenial(actor, requiredRole);
}

export function auditTrail(): readonly AuditRecord[] {
  return records;
}
