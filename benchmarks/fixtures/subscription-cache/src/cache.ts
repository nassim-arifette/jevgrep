export type CacheEntry = {
  readonly payload: string;
  readonly expiresAtMs: number;
};

const users = new Map<string, CacheEntry>();

export function cacheUser(userId: string, payload: string, nowMs: number, ttlSeconds: number): void {
  users.set(userId, { payload, expiresAtMs: nowMs + ttlSeconds * 1000 });
}

export function cachedUser(userId: string, nowMs: number): string | undefined {
  const entry = users.get(userId);
  if (entry === undefined || entry.expiresAtMs <= nowMs) {
    users.delete(userId);
    return undefined;
  }
  return entry.payload;
}

export function invalidateUser(userId: string): void {
  users.delete(userId);
}
