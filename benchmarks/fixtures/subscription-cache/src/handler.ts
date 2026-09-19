import { invalidateUser } from './cache.ts';
import { decodeEvent } from './events.ts';
import { scheduleRefresh } from './refresh-queue.ts';

export function handleWebhook(body: string): void {
  const event = decodeEvent(body);
  switch (event.kind) {
    case 'subscription.changed':
      invalidateUser(event.userId);
      return;
    case 'profile.changed':
      scheduleRefresh(event.userId);
  }
}
