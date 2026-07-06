import { describe, expect, test } from "bun:test";
import { available, needsReorder, reserve } from "../src/domain/inventory";
import { InventoryRepository } from "../src/repository/inventoryRepository";
import { InventoryService } from "../src/services/inventoryService";

describe("inventory", () => {
  test("available is on-hand minus reserved", () => {
    expect(available({ sku: "x", onHand: 20, reserved: 5 })).toBe(15);
  });

  test("reserving reduces availability", () => {
    const next = reserve({ sku: "x", onHand: 20, reserved: 5 }, 4);
    expect(available(next)).toBe(11);
  });

  test("needsReorder triggers at or below threshold", () => {
    expect(needsReorder({ sku: "x", onHand: 8, reserved: 0 })).toBe(true);
    expect(needsReorder({ sku: "x", onHand: 50, reserved: 0 })).toBe(false);
  });

  test("service lists only low SKUs", () => {
    const svc = new InventoryService(new InventoryRepository());
    svc.stock("low", 3);
    svc.stock("high", 100);
    expect(svc.reorderList()).toEqual(["low"]);
  });
});
