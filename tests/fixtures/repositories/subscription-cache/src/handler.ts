import { invalidateUser } from './cache.ts';
import { decodeEvent } from './events.ts';

export function handleWebhook(body: string): void {
  const event = decodeEvent(body);
  if (event.kind === 'subscription.changed') {
    invalidateUser(event.userId);
  }
}
