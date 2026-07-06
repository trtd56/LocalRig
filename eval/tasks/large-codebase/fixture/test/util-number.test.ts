import { describe, expect, test } from "bun:test";
import { average, clamp, roundTo, sum } from "../src/util/number";

describe("number utils", () => {
  test("clamp bounds a value to a range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test("roundTo rounds to N decimals", () => {
    expect(roundTo(3.14159, 2)).toBe(3.14);
    expect(roundTo(2.71828, 3)).toBe(2.718);
  });

  test("sum adds every element", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  test("average of a list", () => {
    expect(average([2, 4, 6])).toBe(4);
  });
});
