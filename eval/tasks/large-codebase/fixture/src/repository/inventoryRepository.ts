import type { StockLevel } from "../domain/types";

/** In-memory store of stock levels keyed by SKU. */
export class InventoryRepository {
  private items = new Map<string, StockLevel>();

  save(level: StockLevel): void {
    this.items.set(level.sku, level);
  }

  find(sku: string): StockLevel | undefined {
    return this.items.get(sku);
  }

  all(): StockLevel[] {
    return [...this.items.values()];
  }
}
