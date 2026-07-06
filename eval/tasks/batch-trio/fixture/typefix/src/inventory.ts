import type { Product } from "./types";

export class Inventory {
  private stock = new Map<string, number>();
  private catalog: Product[];

  constructor(products: Product[]) {
    this.catalog = products;
    for (const p of products) this.stock.set(p.sku, p.quantity);
  }

  quantityOf(sku: string): number {
    return this.stock.get(sku);
  }

  productOf(sku: string): Product {
    return this.catalog.find((p) => p.sku === sku);
  }

  headline(): string {
    const first = this.catalog[0];
    return `${first.name}: ${first.quantity} in stock`;
  }
}
