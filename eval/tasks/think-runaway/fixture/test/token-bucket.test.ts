import { expect, test } from "bun:test";
import { TokenBucket } from "../src/token-bucket.ts";

test("does not count the same fractional refill interval twice", () => {
  let now = 0;
  const bucket = new TokenBucket(2, 1, () => now);
  expect(bucket.take()).toBe(true);
  expect(bucket.take()).toBe(true);
  now = 1500;
  expect(bucket.take()).toBe(true);
  now = 2000;
  expect(bucket.take()).toBe(true);
  expect(bucket.take()).toBe(false);
});

test("never exceeds capacity after a long idle interval", () => {
  let now = 0;
  const bucket = new TokenBucket(2, 1, () => now);
  now = 10_000;
  expect(bucket.take(2)).toBe(true);
  expect(bucket.take()).toBe(false);
});
