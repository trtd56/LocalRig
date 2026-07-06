import { describe, expect, test } from "bun:test";
import { formatProductLabel, sortByPriceAsc } from "../src/modules/catalog";
import type { Product } from "../src/types";

describe("formatProductLabel", () => {
  test("keeps short names unchanged", () => {
    expect(formatProductLabel("Mug")).toBe("Mug");
  });

  test("truncates long names to at most 15 characters", () => {
    const label = formatProductLabel("Stainless Steel Water Bottle");
    expect(label.length).toBeLessThanOrEqual(15);
    expect(label).toBe("Stainless St...");
  });
});

describe("sortByPriceAsc", () => {
  test("sorts products from cheapest to most expensive", () => {
    const products: Product[] = [
      { name: "b", price: 30 },
      { name: "a", price: 10 },
      { name: "c", price: 20 },
    ];
    expect(sortByPriceAsc(products).map((p) => p.name)).toEqual(["a", "c", "b"]);
  });

  test("does not mutate the input array", () => {
    const products: Product[] = [
      { name: "x", price: 5 },
      { name: "y", price: 1 },
    ];
    sortByPriceAsc(products);
    expect(products.map((p) => p.name)).toEqual(["x", "y"]);
  });

  test("returns an empty array for empty input", () => {
    expect(sortByPriceAsc([])).toEqual([]);
  });
});
