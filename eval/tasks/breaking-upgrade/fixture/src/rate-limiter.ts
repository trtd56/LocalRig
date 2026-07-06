import { createStore, get, remove, set, StorageError, type Store } from "./lib/storage";

export function makeCounterStore(): Store {
  return createStore();
}

export function incrementCounter(store: Store, bucket: string): number {
  let current = 0;
  try {
    current = Number(get(store, `count:${bucket}`));
  } catch (err) {
    if (!(err instanceof StorageError && err.code === "NOT_FOUND")) {
      throw err;
    }
  }
  const next = current + 1;
  set(store, `count:${bucket}`, String(next), 16);
  return next;
}

export function resetCounter(store: Store, bucket: string): boolean {
  try {
    remove(store, `count:${bucket}`);
    return true;
  } catch (err) {
    if (err instanceof StorageError && err.code === "NOT_FOUND") {
      return false;
    }
    throw err;
  }
}
