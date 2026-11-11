/** Approximate retained heap size for JSON cache data, without creating a serialized copy. */
export function residentBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): number => {
    if (typeof item === 'string') return 24 + item.length * 2;
    if (typeof item === 'number') return 8;
    if (typeof item !== 'object' || item === null) return 8;
    if (seen.has(item)) return 0;
    seen.add(item);
    if (Array.isArray(item)) return 32 + item.reduce((bytes: number, child: unknown) => bytes + 8 + visit(child), 0);
    return 48 + Object.entries(item).reduce((bytes, [key, child]) => bytes + 32 + key.length * 2 + visit(child), 0);
  };
  // Include the retaining Map slot and its key/reference overhead. These are heap
  // estimates, independent of the separately enforced serialized disk-cache limit.
  return 192 + visit(value);
}

export function memoryByteLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('cache memory byte limit must be a nonnegative safe integer');
  return limit;
}
