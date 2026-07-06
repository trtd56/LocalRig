import { createStore, get, set, StorageError, type Store } from "./lib/storage";

export function makeCacheStore(): Store {
  return createStore();
}

export function getOrCompute(store: Store, key: string, compute: () => string): string {
  try {
    return get(store, key);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === "NOT_FOUND")) {
      throw err;
    }
  }
  const value = compute();
  set(store, key, value, 2048);
  return value;
}
