const userCache = new Map<string, string>();

export function cacheUser(userId: string, payload: string): void {
  userCache.set(userId, payload);
}

export function invalidateUser(userId: string): void {
  userCache.delete(userId);
}

export function cachedUser(userId: string): string | undefined {
  return userCache.get(userId);
}
