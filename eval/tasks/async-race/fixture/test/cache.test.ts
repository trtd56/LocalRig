import { describe, expect, test } from "bun:test";
import { AsyncCache } from "../src/cache";
import { Deferred } from "./deferred";

describe("AsyncCache - sequential access (baseline behavior)", () => {
  test("second call for the same key is served from cache, loader runs once", async () => {
    const cache = new AsyncCache<string, number>();
    let loadCount = 0;
    const loader = async () => {
      loadCount++;
      return 42;
    };

    const first = await cache.getOrLoad("k", loader);
    const second = await cache.getOrLoad("k", loader);

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(loadCount).toBe(1);
  });

  test("different keys are loaded independently", async () => {
    let loadCountA = 0;
    let loadCountB = 0;
    const cache = new AsyncCache<string, string>();

    const a = await cache.getOrLoad("a", async () => {
      loadCountA++;
      return "value-a";
    });
    const b = await cache.getOrLoad("b", async () => {
      loadCountB++;
      return "value-b";
    });

    expect(a).toBe("value-a");
    expect(b).toBe("value-b");
    expect(loadCountA).toBe(1);
    expect(loadCountB).toBe(1);
  });

  test("invalidate after a load has settled causes the next call to reload", async () => {
    const cache = new AsyncCache<string, number>();
    let loadCount = 0;
    const loader = async () => {
      loadCount++;
      return loadCount;
    };

    expect(await cache.getOrLoad("k", loader)).toBe(1);
    cache.invalidate("k");
    expect(await cache.getOrLoad("k", loader)).toBe(2);
    expect(loadCount).toBe(2);
  });

  test("a rejected loader is not cached, so the next call retries", async () => {
    const cache = new AsyncCache<string, string>();
    let attempt = 0;
    const loader = async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient failure");
      return "recovered";
    };

    await expect(cache.getOrLoad("k", loader)).rejects.toThrow("transient failure");
    expect(cache.has("k")).toBe(false);
    expect(await cache.getOrLoad("k", loader)).toBe("recovered");
    expect(attempt).toBe(2);
  });

  test("has() reflects whether a key is currently cached", async () => {
    const cache = new AsyncCache<string, string>();
    expect(cache.has("k")).toBe(false);
    await cache.getOrLoad("k", async () => "value");
    expect(cache.has("k")).toBe(true);
    cache.invalidate("k");
    expect(cache.has("k")).toBe(false);
  });

  test("stats count loads, hits and misses correctly", async () => {
    const cache = new AsyncCache<string, string>();
    await cache.getOrLoad("a", async () => "a-value"); // miss + load
    await cache.getOrLoad("b", async () => "b-value"); // miss + load
    await cache.getOrLoad("a", async () => "a-value-again"); // hit

    expect(cache.stats.loads).toBe(2);
    expect(cache.stats.misses).toBe(2);
    expect(cache.stats.hits).toBe(1);
  });
});

describe("AsyncCache - concurrent access (the actual bugs)", () => {
  test("two concurrent getOrLoad calls for the same key share one load", async () => {
    const cache = new AsyncCache<string, string>();
    const deferred = new Deferred<string>();
    let loadCount = 0;
    const loader = () => {
      loadCount++;
      return deferred.promise;
    };

    const p1 = cache.getOrLoad("k", loader);
    const p2 = cache.getOrLoad("k", loader);

    deferred.resolve("value");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(loadCount).toBe(1);
    expect(r1).toBe("value");
    expect(r2).toBe("value");
    expect(cache.stats.loads).toBe(1);
  });

  test("callers that join an in-flight load across microtask ticks still share it", async () => {
    const cache = new AsyncCache<string, string>();
    const deferred = new Deferred<string>();
    let loadCount = 0;
    const loader = () => {
      loadCount++;
      return deferred.promise;
    };

    const p1 = cache.getOrLoad("k", loader);
    await Promise.resolve();
    const p2 = cache.getOrLoad("k", loader);
    await Promise.resolve();
    const p3 = cache.getOrLoad("k", loader);

    deferred.resolve("value");
    const results = await Promise.all([p1, p2, p3]);

    expect(loadCount).toBe(1);
    expect(results).toEqual(["value", "value", "value"]);
  });

  test("invalidate while a load is in flight prevents the stale result from being cached", async () => {
    const cache = new AsyncCache<string, string>();
    const deferred = new Deferred<string>();
    const loader = () => deferred.promise;

    const pending = cache.getOrLoad("k", loader);
    cache.invalidate("k");
    deferred.resolve("stale-value");
    await pending;

    expect(cache.has("k")).toBe(false);
  });

  test("after an in-flight load is invalidated, the next getOrLoad reloads instead of returning the stale value", async () => {
    const cache = new AsyncCache<string, string>();
    const staleLoad = new Deferred<string>();
    let loadCount = 0;
    const staleLoader = () => {
      loadCount++;
      return staleLoad.promise;
    };

    const pending = cache.getOrLoad("k", staleLoader);
    cache.invalidate("k");
    staleLoad.resolve("stale-value");
    await pending;

    const freshLoad = new Deferred<string>();
    const freshLoader = () => {
      loadCount++;
      return freshLoad.promise;
    };
    const p2 = cache.getOrLoad("k", freshLoader);
    freshLoad.resolve("fresh-value");
    const result = await p2;

    expect(result).toBe("fresh-value");
    expect(loadCount).toBe(2);
  });
});
