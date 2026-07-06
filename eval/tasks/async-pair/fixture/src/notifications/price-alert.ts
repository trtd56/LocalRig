import { fmtMoney } from "../lib/money";

export function priceAlert(product: string, targetCents: number): string {
  return `${product} dropped to ${fmtMoney(targetCents, "$")}!`;
}
