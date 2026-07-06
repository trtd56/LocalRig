import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/parse-duration";

describe("parseDuration", () => {
  test("seconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
  });

  test("minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  test("hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("unknown unit throws", () => {
    expect(() => parseDuration("10x")).toThrow();
  });

  test("empty string throws", () => {
    expect(() => parseDuration("")).toThrow();
  });

  test("missing number throws", () => {
    expect(() => parseDuration("h")).toThrow();
  });
});
