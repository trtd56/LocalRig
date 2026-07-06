import { describe, expect, test } from "bun:test";
import { finalPrice, inventoryValue, priceLabel } from "../src/pricing";
import type { Product } from "../src/types";

const widget: Product = { sku: "A1", name: "Widget", price: 10, quantity: 5 };

describe("pricing", () => {
  test("finalPrice subtracts a fixed discount", () => {
    expect(finalPrice(widget, { kind: "fixed", amount: 3 })).toBe(7);
  });

  test("priceLabel formats price with the given currency", () => {
    expect(priceLabel(widget, "usd")).toBe("USD 10.00");
  });

  test("inventoryValue of an empty catalog is zero", () => {
    expect(inventoryValue([])).toBe(0);
  });
});
