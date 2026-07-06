import { describe, expect, test } from "bun:test";
import { CatalogService } from "../src/services/catalogService";
import { ProductRepository } from "../src/repository/productRepository";
import { isPremium } from "../src/domain/product";

describe("catalog", () => {
  test("add, list, and look up a price", () => {
    const svc = new CatalogService(new ProductRepository());
    svc.add("pen", "Pen", 2.5, "stationery");
    svc.add("desk", "Desk", 150, "furniture");
    expect(svc.list()).toHaveLength(2);
    expect(svc.list("furniture").map((p) => p.sku)).toEqual(["desk"]);
    expect(svc.priceOf("pen")).toBe(2.5);
  });

  test("rejects a non-positive price", () => {
    const svc = new CatalogService(new ProductRepository());
    expect(() => svc.add("bad", "Bad", 0, "misc")).toThrow();
  });

  test("premium threshold", () => {
    expect(isPremium({ sku: "d", name: "Desk", unitPrice: 150, category: "f" })).toBe(true);
    expect(isPremium({ sku: "p", name: "Pen", unitPrice: 2.5, category: "s" })).toBe(false);
  });
});
