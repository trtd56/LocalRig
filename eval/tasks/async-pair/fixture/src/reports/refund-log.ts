import { fmtMoney } from "../lib/money";

export function refundLine(orderId: string, refundCents: number): string {
  return `refund #${orderId}: ${fmtMoney(refundCents, "$")}`;
}
