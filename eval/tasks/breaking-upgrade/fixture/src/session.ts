import { createStore, get, remove, set, StorageError, type Store } from "./lib/storage";

// Session tokens are short opaque strings, historically well under the
// storage library's default 1KB size limit — callers never had to pass
// maxBytes explicitly to fit under it.

export function makeSessionStore(): Store {
  return createStore();
}

export function saveSession(store: Store, sessionId: string, token: string): void {
  try {
    set(store, `session:${sessionId}`, token);
  } catch (err) {
    if (err instanceof StorageError && err.code === "QUOTA_EXCEEDED") {
      throw new Error(`session token too large for session ${sessionId}`);
    }
    throw err;
  }
}

export function loadSession(store: Store, sessionId: string): string | null {
  try {
    return get(store, `session:${sessionId}`);
  } catch (err) {
    if (err instanceof StorageError && err.code === "NOT_FOUND") {
      return null;
    }
    throw err;
  }
}

export function endSession(store: Store, sessionId: string): void {
  try {
    remove(store, `session:${sessionId}`);
  } catch (err) {
    if (err instanceof StorageError && err.code === "NOT_FOUND") {
      return;
    }
    throw err;
  }
}
