import { describe, expect, test } from "bun:test";
import { cartLine } from "../src/checkout/cart";
import { receiptTotals } from "../src/checkout/receipt";
import { orderSummary } from "../src/checkout/summary";
import { productCard } from "../src/catalog/product-card";
import { priceTag } from "../src/catalog/price-tag";
import { saleBadge } from "../src/catalog/sale-badge";
import { dailySales } from "../src/reports/daily-sales";
import { refundLine } from "../src/reports/refund-log";
import { orderEmail } from "../src/notifications/order-email";
import { priceAlert } from "../src/notifications/price-alert";

// The migration from lib/money (positional args) to lib/pricing (options object)
// must preserve behaviour: every output below is identical whether a caller uses
// the deprecated money.ts API or the new pricing.ts API. They fail if an argument
// is dropped, swapped, or mapped to the wrong option key.
describe("async-pair Part A behaviour is preserved", () => {
  test("cartLine", () => {
    expect(cartLine("Widget", 500, 3, 10)).toBe("Widget x3: $13.50");
  });

  test("receiptTotals", () => {
    expect(receiptTotals(2000, 160)).toBe("Subtotal: $20.00\nTax: $1.60");
  });

  test("orderSummary", () => {
    expect(orderSummary(5000, 25)).toBe("Total $50.00 → due $37.50");
  });

  test("productCard", () => {
    expect(productCard("Mug", 899)).toBe("Mug — $8.99");
  });

  test("priceTag", () => {
    expect(priceTag(2500, 20)).toBe("was $25.00 now $20.00");
  });

  test("saleBadge", () => {
    expect(saleBadge(4000, 15)).toBe("Save $6.00 (15% off)");
  });

  test("dailySales", () => {
    expect(dailySales(100000, 2500)).toBe("gross $1000.00 / net $975.00");
  });

  test("refundLine", () => {
    expect(refundLine("A-9", 1250)).toBe("refund #A-9: $12.50");
  });

  test("orderEmail", () => {
    expect(orderEmail("Sam", 8000, 50)).toBe("Hi Sam, you paid $40.00.");
  });

  test("priceAlert", () => {
    expect(priceAlert("Lamp", 3499)).toBe("Lamp dropped to $34.99!");
  });
});
