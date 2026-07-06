import { truncate } from "../utils/strings";
import type { Product } from "../types";

/** Builds a display label for a product, truncated to at most 15 characters. */
export function formatProductLabel(name: string): string {
  return truncate(name, 15);
}

/**
 * Returns a new array of products sorted by price ascending (cheapest
 * first). Does not mutate the input array. Products with equal price keep
 * their original relative order.
 */
export function sortByPriceAsc(products: Product[]): Product[] {
  return [...products].sort((a, b) => b.price - a.price);
}
