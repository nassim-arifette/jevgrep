const queuedUsers = new Set<string>();

export function scheduleRefresh(userId: string): void {
  queuedUsers.add(userId);
}

export function drainRefreshQueue(): readonly string[] {
  const pending = [...queuedUsers].sort();
  queuedUsers.clear();
  return pending;
}
