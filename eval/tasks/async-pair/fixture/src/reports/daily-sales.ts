import { fmtMoney } from "../lib/money";

export function dailySales(grossCents: number, refundCents: number): string {
  const netCents = grossCents - refundCents;
  return `gross ${fmtMoney(grossCents, "$")} / net ${fmtMoney(netCents, "$")}`;
}
