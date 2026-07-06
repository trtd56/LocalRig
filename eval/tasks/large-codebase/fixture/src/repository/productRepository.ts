import type { Product } from "../domain/types";

/** In-memory store of products keyed by SKU. */
export class ProductRepository {
  private items = new Map<string, Product>();

  save(product: Product): void {
    this.items.set(product.sku, product);
  }

  find(sku: string): Product | undefined {
    return this.items.get(sku);
  }

  all(): Product[] {
    return [...this.items.values()];
  }

  byCategory(category: string): Product[] {
    return this.all().filter((p) => p.category === category);
  }
}
