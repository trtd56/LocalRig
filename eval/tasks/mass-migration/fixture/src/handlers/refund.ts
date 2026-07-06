import { log } from "../lib/log";

// module-source: billing.refund
export function refundLine(id: string, cents: number): string {
  return log.write("info", `refund ${id} cents=${cents}`);
}
