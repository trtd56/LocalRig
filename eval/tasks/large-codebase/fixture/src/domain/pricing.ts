import type { OrderLine } from "./types";
import { round2 } from "../util/decimal";
import { applyRate } from "../util/percentage";
import { sumBy } from "../util/collection";

/** Raw subtotal for a single line: unit price times quantity. */
export function lineSubtotal(line: OrderLine): number {
  return line.unitPrice * line.quantity;
}

/** Sum of every line's subtotal, before tax. */
export function subtotal(lines: OrderLine[]): number {
  return sumBy(lines, lineSubtotal);
}

/** Apply a tax rate to an amount and round to currency precision. */
export function applyTax(amount: number, rate: number): number {
  return round2(applyRate(amount, rate));
}

/** Final payable order total: subtotal plus tax, rounded. */
export function orderTotal(lines: OrderLine[], rate: number): number {
  return applyTax(subtotal(lines), rate);
}
