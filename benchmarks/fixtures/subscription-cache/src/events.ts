export type UserEvent =
  | { readonly kind: 'subscription.changed'; readonly userId: string; readonly plan: string }
  | { readonly kind: 'profile.changed'; readonly userId: string };

export function decodeEvent(body: string): UserEvent {
  const candidate: unknown = JSON.parse(body);
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('event must be an object');
  }
  const event = candidate as { kind?: unknown; userId?: unknown; plan?: unknown };
  if (typeof event.userId !== 'string' || event.userId.length === 0) {
    throw new Error('event userId is required');
  }
  if (event.kind === 'subscription.changed' && typeof event.plan === 'string') {
    return { kind: event.kind, userId: event.userId, plan: event.plan };
  }
  if (event.kind === 'profile.changed') {
    return { kind: event.kind, userId: event.userId };
  }
  throw new Error('unsupported event kind');
}
