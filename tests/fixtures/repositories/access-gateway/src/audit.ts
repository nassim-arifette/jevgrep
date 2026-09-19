export type AuditRecord = {
  readonly actorId: string;
  readonly route: string;
  readonly allowed: boolean;
};

export function recordDecision(records: AuditRecord[], record: AuditRecord): void {
  records.push(record);
}
