export type Loader<V> = () => Promise<V>;

export interface CacheStats {
  /** Number of times a loader function was actually invoked. */
  loads: number;
  /** Number of getOrLoad calls that did NOT need to invoke a loader,
   *  because the value was already cached or an in-flight load for the
   *  same key could be reused. */
  hits: number;
  /** Number of getOrLoad calls that started a brand-new load. */
  misses: number;
}

/**
 * AsyncCache memoizes the result of an async loader function per key.
 *
 * Intended contract:
 *
 * - `getOrLoad(key, loader)`: returns the cached value for `key` if one
 *   exists. Otherwise it must start exactly one load per key: if a load
 *   for `key` is already in flight (a previous getOrLoad call for the
 *   same key hasn't resolved yet), concurrent callers must await that
 *   same in-flight promise instead of invoking `loader` again. `loader`
 *   is a potentially expensive/side-effecting operation (network call,
 *   disk read, ...) and must not be run more than once per key per
 *   "generation" (see invalidate below).
 *
 * - `invalidate(key)`: drops any cached value for `key`. If a load for
 *   `key` is in flight when `invalidate` is called, that load is already
 *   stale by the time it resolves: its result must NOT be written back
 *   into the cache, and the next `getOrLoad(key, ...)` call must start a
 *   fresh load rather than reuse the outdated one.
 *
 * - `has(key)`: true only if a value for `key` is currently cached. Does
 *   not count in-flight loads that haven't resolved yet.
 *
 * - `stats`: bookkeeping intended for callers/tests. `loads` must equal
 *   the number of times a loader passed to `getOrLoad` was actually
 *   invoked (not the number of getOrLoad calls).
 */
export class AsyncCache<K, V> {
  private readonly cache = new Map<K, V>();
  private readonly inFlight = new Map<K, Promise<V>>();
  readonly stats: CacheStats = { loads: 0, hits: 0, misses: 0 };

  async getOrLoad(key: K, loader: Loader<V>): Promise<V> {
    if (this.cache.has(key)) {
      this.stats.hits++;
      return this.cache.get(key)!;
    }

    this.stats.misses++;
    this.stats.loads++;
    const promise = loader()
      .then((value) => {
        this.cache.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key: K): void {
    this.cache.delete(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}
