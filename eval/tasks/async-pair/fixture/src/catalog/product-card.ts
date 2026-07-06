import { fmtMoney } from "../lib/money";

export function productCard(title: string, priceCents: number): string {
  return `${title} — ${fmtMoney(priceCents, "$")}`;
}
