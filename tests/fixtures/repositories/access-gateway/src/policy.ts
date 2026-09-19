export type Actor = { readonly id: string; readonly roles: readonly string[] };

export function mayEnter(actor: Actor, requiredRole: string): boolean {
  return actor.roles.includes(requiredRole);
}

export function explainDenial(actor: Actor, requiredRole: string): string {
  return `actor ${actor.id} lacks ${requiredRole}`;
}
