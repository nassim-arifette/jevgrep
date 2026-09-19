export interface ObjectStore {
  put(key: string, bytes: Uint8Array, visibility: 'private'): Promise<void>;
  copy(source: string, target: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function storageAdapter(store: ObjectStore, freshId: () => string) {
  return {
    async quarantine(bytes: Uint8Array): Promise<string> {
      const key = 'quarantine/' + freshId();
      await store.put(key, bytes, 'private');
      return key;
    },
    async publish(key: string): Promise<string> {
      const target = key.replace(/^quarantine\//, 'public/');
      await store.copy(key, target);
      await store.delete(key);
      return '/objects/' + target;
    },
    async discard(key: string): Promise<void> {
      await store.delete(key);
    },
  };
}
