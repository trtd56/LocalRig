import { createStore, get, set, StorageError, type Store } from "./lib/storage";

export interface SetPreferenceResult {
  success: boolean;
  message?: string;
}

export function makePreferencesStore(): Store {
  return createStore();
}

export function setPreference(store: Store, key: string, value: string): SetPreferenceResult {
  try {
    set(store, key, value, 512);
    return { success: true };
  } catch (err) {
    if (err instanceof StorageError && err.code === "INVALID_KEY") {
      return { success: false, message: "preference key must not be empty" };
    }
    if (err instanceof StorageError && err.code === "QUOTA_EXCEEDED") {
      return { success: false, message: "preference value too long" };
    }
    throw err;
  }
}

export function getPreference(store: Store, key: string, fallback: string): string {
  try {
    return get(store, key);
  } catch (err) {
    if (err instanceof StorageError && err.code === "NOT_FOUND") {
      return fallback;
    }
    throw err;
  }
}
