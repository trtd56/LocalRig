import { describe, expect, test } from "bun:test";
import { Inventory } from "../src/inventory";
import type { Product } from "../src/types";

const products: Product[] = [
  { sku: "A1", name: "Widget", price: 9.99, quantity: 5 },
  { sku: "B2", name: "Gadget", price: 19.5, quantity: 3 },
];

describe("Inventory", () => {
  test("quantityOf returns the stock for a known sku", () => {
    const inv = new Inventory(products);
    expect(inv.quantityOf("A1")).toBe(5);
    expect(inv.quantityOf("B2")).toBe(3);
  });

  test("productOf returns the product for a known sku", () => {
    const inv = new Inventory(products);
    const p = inv.productOf("B2");
    expect(p.name).toBe("Gadget");
    expect(p.price).toBe(19.5);
  });

  test("headline describes the first catalog entry", () => {
    const inv = new Inventory(products);
    expect(inv.headline()).toBe("Widget: 5 in stock");
  });
});
