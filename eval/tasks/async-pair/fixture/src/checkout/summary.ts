import { fmtMoney, discountCents } from "../lib/money";

export function orderSummary(totalCents: number, pct: number): string {
  const due = discountCents(totalCents, pct);
  return `Total ${fmtMoney(totalCents, "$")} → due ${fmtMoney(due, "$")}`;
}
