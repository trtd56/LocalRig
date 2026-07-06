import { fmtMoney, discountCents } from "../lib/money";

export function orderEmail(customer: string, totalCents: number, pct: number): string {
  const charged = discountCents(totalCents, pct);
  return `Hi ${customer}, you paid ${fmtMoney(charged, "$")}.`;
}
