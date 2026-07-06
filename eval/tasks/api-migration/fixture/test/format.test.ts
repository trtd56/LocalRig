import { describe, expect, test } from "bun:test";
import { cartSummary, cartTotal } from "../src/cart";
import { receiptLines } from "../src/receipt";
import { dailyReport } from "../src/report";
import { formatMoney } from "../src/lib/money";

const items = [
  { name: "pen", unitPrice: 1.5, quantity: 2 },
  { name: "notebook", unitPrice: 4.0, quantity: 1 },
];

describe("money migration", () => {
  test("formatMoney (new API)", () => {
    expect(formatMoney({ amount: 12, currency: "USD" })).toBe("USD 12.00");
  });

  test("cartTotal", () => {
    expect(cartTotal(items)).toBe(7);
  });

  test("cartSummary uses the new format", () => {
    expect(cartSummary(items, "USD")).toBe("2 items — USD 7.00");
  });

  test("receiptLines use the new format", () => {
    expect(receiptLines(items, "EUR")).toEqual(["pen x2  EUR 3.00", "notebook x1  EUR 4.00"]);
  });

  test("dailyReport uses the new format", () => {
    expect(dailyReport(100, 12.5, "JPY")).toBe(
      "revenue: JPY 100.00\nrefunds: JPY 12.50\nnet: JPY 87.50",
    );
  });
});
