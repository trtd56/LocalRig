import { log } from "../lib/log";

// module-source: billing.invoice
export function invoiceLine(label: string, amount: number): string {
  return log.write("info", `invoice ${label} amount=${amount}`);
}
export function invoiceVoid(id: string): string {
  return log.write("warn", `voided invoice ${id}`);
}
