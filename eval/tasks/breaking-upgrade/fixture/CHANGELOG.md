# Changelog

## 2.0.0

### Breaking changes

- **Options objects instead of positional arguments.** `set`, `get`, and
  `remove` now take a single options object as their second parameter.

  ```ts
  // v1
  set(store, key, value, maxBytes);
  get(store, key);
  remove(store, key);

  // v2
  set(store, { key, value, maxBytes });
  get(store, { key });
  remove(store, { key });
  ```

- **No more throwing.** v1 threw a `StorageError` on failure. v2 never
  throws — every function returns a `Result<T>`:

  ```ts
  type Result<T> = { ok: true; value: T } | { ok: false; error: StorageErrorInfo };
  ```

  Callers must check `result.ok` instead of wrapping calls in try/catch.

- **Error codes renamed.** The `code` field on the error object changed:

  | v1 (`StorageError.code`) | v2 (`StorageErrorInfo.code`) |
  | ------------------------- | ----------------------------- |
  | `NOT_FOUND`                | `ERR_MISSING_KEY`              |
  | `QUOTA_EXCEEDED`           | `ERR_TOO_LARGE`                |
  | `INVALID_KEY`              | `ERR_BAD_KEY`                  |

  Error messages were also reworded (all v2 messages are now prefixed with
  `storage:`) and are not guaranteed to stay stable across minor versions —
  branch on `code`, not on message text.

- **Default `maxBytes` lowered from 1024 to 256.** Callers that relied on
  the implicit 1KB ceiling and did not pass `maxBytes` explicitly must now
  pass `{ maxBytes: 1024 }` to keep the old limit. This mainly bites callers
  storing values in the 256–1024 byte range that never hit the old default's
  quota error and therefore never had a reason to pass `maxBytes` at all.

### Migration

Import from `./lib/storage2` instead of `./lib/storage`. `./lib/storage`
(v1) is deprecated and will be removed in the next major release.
