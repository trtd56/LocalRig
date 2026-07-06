import { roundTo } from "../util/number";

/** Apply a percentage discount (0.1 = 10%) to a price, rounded to cents. */
export function applyDiscount(price: number, pct: number): number {
  return roundTo(price * (1 - pct), 2);
}

/** Price after a fixed amount off, never going below zero. */
export function applyMarkdown(price: number, amountOff: number): number {
  return Math.max(0, roundTo(price - amountOff, 2));
}
