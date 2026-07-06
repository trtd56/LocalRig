import { log } from "../lib/log";

// module-source: ext.stripe
export function stripeCharge(id: string, cents: number): string {
  return log.write("info", `charge ${id} cents=${cents}`);
}
