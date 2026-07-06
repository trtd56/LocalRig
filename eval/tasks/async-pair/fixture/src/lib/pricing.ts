export interface MoneyOptions {
  cents: number;
  symbol: string;
}

/** Money formatter: cents → "<symbol><amount>" with 2 decimals. */
export function formatMoney({ cents, symbol }: MoneyOptions): string {
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

export interface DiscountOptions {
  cents: number;
  pct: number;
}

/** Discount: returns the discounted amount in cents, rounded to the nearest cent. */
export function discount({ cents, pct }: DiscountOptions): number {
  return Math.round(cents * (1 - pct / 100));
}
