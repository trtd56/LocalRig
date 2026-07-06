import type { StockLevel } from "./types";
import { clamp } from "../util/number";
import { REORDER_THRESHOLD } from "../config/limits";
import { OutOfStockError } from "./errors";

/** Units that can still be sold: on-hand minus what is already reserved. */
export function available(stock: StockLevel): number {
  return clamp(stock.onHand - stock.reserved, 0, stock.onHand);
}

/** Whether the SKU has dropped to the reorder point. */
export function needsReorder(stock: StockLevel): boolean {
  return available(stock) <= REORDER_THRESHOLD;
}

/** Reserve `qty` units, returning the updated level. */
export function reserve(stock: StockLevel, qty: number): StockLevel {
  if (qty > available(stock)) throw new OutOfStockError(stock.sku);
  return { ...stock, reserved: stock.reserved + qty };
}
