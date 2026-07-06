import { InventoryRepository } from "../repository/inventoryRepository";
import { available, needsReorder, reserve } from "../domain/inventory";

/** Tracks stock levels and reservations. */
export class InventoryService {
  constructor(private inventory: InventoryRepository) {}

  stock(sku: string, onHand: number): void {
    this.inventory.save({ sku, onHand, reserved: 0 });
  }

  availableFor(sku: string): number {
    const level = this.inventory.find(sku);
    return level ? available(level) : 0;
  }

  reserve(sku: string, qty: number): void {
    const level = this.inventory.find(sku);
    if (!level) throw new Error(`unknown sku: ${sku}`);
    this.inventory.save(reserve(level, qty));
  }

  reorderList(): string[] {
    return this.inventory.all().filter(needsReorder).map((l) => l.sku);
  }
}
