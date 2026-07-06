import { fmtNum } from "../lib/fmt";

export function revenueReport(gross: number, tax: number): string {
  return [
    `gross: ${fmtNum(gross, 2)}`,
    `tax:   ${fmtNum(tax, 2)}`,
  ].join("\n");
}
