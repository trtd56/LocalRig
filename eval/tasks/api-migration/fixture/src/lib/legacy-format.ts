/** @deprecated Use formatMoney from ./money instead (options-object API, "USD 12.00" style). */
export function formatMoney(amount: number, currency: string): string {
  return `${currency}${amount.toFixed(2)}`;
}
