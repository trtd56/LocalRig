import { log } from "../lib/log";

// module-source: orders.modify
export function orderModify(id: string, field: string): string {
  return log.write("info", `order ${id} changed ${field}`);
}
