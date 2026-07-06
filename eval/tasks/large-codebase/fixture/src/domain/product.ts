import type { Product } from "./types";
import { assertPositive } from "../util/assert";

/** Build a validated Product. */
export function createProduct(
  sku: string,
  name: string,
  unitPrice: number,
  category: string,
): Product {
  assertPositive(unitPrice, "unitPrice");
  return { sku, name, unitPrice, category };
}

/** Products at or above this price are considered premium. */
export function isPremium(product: Product): boolean {
  return product.unitPrice >= 100;
}
