import { formatDate, daysBetween } from "../utils/dates";
import { sum } from "../utils/aggregate";

export interface LineItem {
  amount: number;
}

export function formatInvoiceDate(iso: string): string {
  return formatDate(iso);
}

export function calcAgingDays(issuedIso: string, todayIso: string): number {
  return daysBetween(issuedIso, todayIso);
}

export function calcTotal(items: LineItem[]): number {
  return sum(items.map((i) => i.amount));
}
