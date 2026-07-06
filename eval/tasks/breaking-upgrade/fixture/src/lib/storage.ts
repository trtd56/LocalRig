/**
 * @deprecated v1 storage API. Throws StorageError on failure; arguments are
 * positional. Superseded by ./storage2 (v2) — see CHANGELOG.md before
 * migrating, v2 changes more than just the argument shape.
 */

export type StorageErrorCode = "NOT_FOUND" | "QUOTA_EXCEEDED" | "INVALID_KEY";

export class StorageError extends Error {
  code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface Store {
  data: Map<string, string>;
}

export function createStore(): Store {
  return { data: new Map() };
}

const DEFAULT_MAX_BYTES = 1024;

export function set(store: Store, key: string, value: string, maxBytes: number = DEFAULT_MAX_BYTES): void {
  if (!key) {
    throw new StorageError("INVALID_KEY", "key must not be empty");
  }
  if (value.length > maxBytes) {
    throw new StorageError("QUOTA_EXCEEDED", `value for "${key}" exceeds ${maxBytes} bytes`);
  }
  store.data.set(key, value);
}

export function get(store: Store, key: string): string {
  const value = store.data.get(key);
  if (value === undefined) {
    throw new StorageError("NOT_FOUND", `key "${key}" not found`);
  }
  return value;
}

export function remove(store: Store, key: string): void {
  if (!store.data.has(key)) {
    throw new StorageError("NOT_FOUND", `key "${key}" not found`);
  }
  store.data.delete(key);
}
