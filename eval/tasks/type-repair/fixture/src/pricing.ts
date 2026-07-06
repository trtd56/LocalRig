import type { Discount, Product } from "./types";

export function finalPrice(product: Product, discount: Discount): number {
  return product.price - discount.amount;
}

export function priceLabel(product: Product, currency?: string): string {
  return currency.toUpperCase() + " " + product.price.toFixed(2);
}

export function inventoryValue(products: Product[]): number {
  let total = 0;
  for (const p of products) total += p.price * p.quantitiy;
  return total;
}
