import { createStore, get, set, StorageError, type Store } from "./lib/storage";

const DEFAULT_TIMEOUT_MS = 5000;

export function makeConfigStore(): Store {
  return createStore();
}

export function readTimeoutMs(store: Store): number {
  try {
    return Number(get(store, "config:timeoutMs"));
  } catch (err) {
    if (err instanceof StorageError && err.code === "NOT_FOUND") {
      return DEFAULT_TIMEOUT_MS;
    }
    throw err;
  }
}

export function writeTimeoutMs(store: Store, ms: number): void {
  set(store, "config:timeoutMs", String(ms), 64);
}
