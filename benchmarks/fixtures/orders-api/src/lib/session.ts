import { randomUUID } from 'node:crypto';
import type { Role } from '../middleware/authenticate';

export type Session = { readonly userId: string; readonly role: Role };

const sessions = new Map<string, Session>();
const TTL_MS = 12 * 3_600_000;

export function issueSession(userId: string, role: Role): string {
  const token = randomUUID();
  sessions.set(token, { userId, role });
  setTimeout(() => sessions.delete(token), TTL_MS).unref();
  return token;
}

export async function readSession(token: string): Promise<Session | undefined> {
  return sessions.get(token);
}
