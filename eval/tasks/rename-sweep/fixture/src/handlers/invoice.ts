import { fmtNum } from "../lib/fmt";

export interface LineItem {
  label: string;
  qty: number;
  unitPrice: number;
}

export function invoiceLine(item: LineItem): string {
  const amount = item.qty * item.unitPrice;
  return `${item.label} x${item.qty} @ ${fmtNum(item.unitPrice, 2)} = ${fmtNum(amount, 2)}`;
}
