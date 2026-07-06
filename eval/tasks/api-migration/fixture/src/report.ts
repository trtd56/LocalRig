import { formatMoney } from "./lib/legacy-format";

export function dailyReport(revenue: number, refunds: number, currency: string): string {
  return [
    `revenue: ${formatMoney(revenue, currency)}`,
    `refunds: ${formatMoney(refunds, currency)}`,
    `net: ${formatMoney(revenue - refunds, currency)}`,
  ].join("\n");
}
