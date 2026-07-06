import { fmtDate } from "../lib/fmt";

export function shipmentNotice(tracking: string, shipsAt: Date): string {
  return `${tracking} ships ${fmtDate(shipsAt, "MM/DD")}`;
}
