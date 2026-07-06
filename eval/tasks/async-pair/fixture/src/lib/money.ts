/** @deprecated Use formatMoney / discount from ./pricing instead (options-object API). */

/** Legacy money formatter: cents → "<symbol><amount>" with 2 decimals. */
export function fmtMoney(cents: number, symbol: string): string {
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Legacy discount: returns the discounted amount in cents, rounded to the nearest cent. */
export function discountCents(cents: number, pct: number): number {
  return Math.round(cents * (1 - pct / 100));
}
