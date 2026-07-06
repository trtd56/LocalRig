/**
 * v2 storage API. Options-object arguments; never throws — every function
 * returns a Result. See CHANGELOG.md for the full list of breaking changes
 * from v1 (./storage).
 */

export type StorageErrorCode = "ERR_MISSING_KEY" | "ERR_TOO_LARGE" | "ERR_BAD_KEY";

export interface StorageErrorInfo {
  code: StorageErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: StorageErrorInfo };

export interface Store {
  data: Map<string, string>;
}

export function createStore(): Store {
  return { data: new Map() };
}

const DEFAULT_MAX_BYTES = 256;

export interface SetOptions {
  key: string;
  value: string;
  maxBytes?: number;
}

export function set(store: Store, opts: SetOptions): Result<void> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!opts.key) {
    return { ok: false, error: { code: "ERR_BAD_KEY", message: "storage: key must not be empty" } };
  }
  if (opts.value.length > maxBytes) {
    return {
      ok: false,
      error: {
        code: "ERR_TOO_LARGE",
        message: `storage: value for key "${opts.key}" exceeds ${maxBytes} bytes`,
      },
    };
  }
  store.data.set(opts.key, opts.value);
  return { ok: true, value: undefined };
}

export interface GetOptions {
  key: string;
}

export function get(store: Store, opts: GetOptions): Result<string> {
  const value = store.data.get(opts.key);
  if (value === undefined) {
    return {
      ok: false,
      error: { code: "ERR_MISSING_KEY", message: `storage: no value found for key "${opts.key}"` },
    };
  }
  return { ok: true, value };
}

export interface RemoveOptions {
  key: string;
}

export function remove(store: Store, opts: RemoveOptions): Result<void> {
  if (!store.data.has(opts.key)) {
    return {
      ok: false,
      error: { code: "ERR_MISSING_KEY", message: `storage: no value found for key "${opts.key}"` },
    };
  }
  store.data.delete(opts.key);
  return { ok: true, value: undefined };
}
