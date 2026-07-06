import { fmtMoney, discountCents } from "../lib/money";

export function priceTag(listCents: number, pct: number): string {
  const sale = discountCents(listCents, pct);
  return `was ${fmtMoney(listCents, "$")} now ${fmtMoney(sale, "$")}`;
}
