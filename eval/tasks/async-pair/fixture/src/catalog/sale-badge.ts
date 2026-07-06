import { fmtMoney, discountCents } from "../lib/money";

export function saleBadge(listCents: number, pct: number): string {
  const saved = listCents - discountCents(listCents, pct);
  return `Save ${fmtMoney(saved, "$")} (${pct}% off)`;
}
