import { fmtMoney } from "../lib/money";

export function receiptTotals(subtotalCents: number, taxCents: number): string {
  return `Subtotal: ${fmtMoney(subtotalCents, "$")}\nTax: ${fmtMoney(taxCents, "$")}`;
}
