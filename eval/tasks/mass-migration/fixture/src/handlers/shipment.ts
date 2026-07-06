import { log } from "../lib/log";

// module-source: orders.shipment
export function shipmentNotice(tracking: string): string {
  return log.write("info", `shipment ${tracking} dispatched`);
}
