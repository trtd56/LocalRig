export interface MoneyFormatOptions {
  amount: number;
  currency: string;
}

/** New formatting API: "USD 12.00" — a space between currency and amount. */
export function formatMoney(opts: MoneyFormatOptions): string {
  return `${opts.currency} ${opts.amount.toFixed(2)}`;
}
