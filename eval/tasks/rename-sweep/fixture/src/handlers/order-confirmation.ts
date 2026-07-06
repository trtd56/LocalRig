import { fmtDate, fmtNum } from "../lib/fmt";

export function orderConfirmation(orderId: string, placedAt: Date, total: number): string {
  return `Order ${orderId} placed ${fmtDate(placedAt, "YYYY-MM-DD")} — total ${fmtNum(total, 2)}`;
}
