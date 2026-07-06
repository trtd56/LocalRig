import { describe, expect, test } from "bun:test";
import { formatInvoiceDate, calcAgingDays, calcTotal } from "../src/modules/invoice";

describe("formatInvoiceDate", () => {
  test("formats the issued date", () => {
    expect(formatInvoiceDate("2024-01-15")).toBe("2024/01/15");
  });
});

describe("calcAgingDays", () => {
  test("counts days since the invoice was issued", () => {
    expect(calcAgingDays("2024-01-01", "2024-01-31")).toBe(30);
  });
});

describe("calcTotal", () => {
  test("sums line item amounts", () => {
    expect(calcTotal([{ amount: 100 }, { amount: 250 }, { amount: 50 }])).toBe(400);
  });

  test("returns 0 for no line items", () => {
    expect(calcTotal([])).toBe(0);
  });
});
