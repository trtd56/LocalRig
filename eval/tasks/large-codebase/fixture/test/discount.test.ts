import { describe, expect, test } from "bun:test";
import { applyDiscount, applyMarkdown } from "../src/domain/discount";

describe("discounts", () => {
  test("percentage discount rounds to cents", () => {
    expect(applyDiscount(100, 0.1)).toBe(90);
    expect(applyDiscount(19.99, 0.2)).toBe(15.99);
  });

  test("markdown never goes negative", () => {
    expect(applyMarkdown(20, 5)).toBe(15);
    expect(applyMarkdown(10, 15)).toBe(0);
  });
});
